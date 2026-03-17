---
title: "Kubernetes Compliance Automation: DISA STIG, CIS Benchmarks, and Continuous Compliance"
date: 2030-11-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Compliance", "CIS", "DISA STIG", "kube-bench", "Falco", "Security", "Audit"]
categories:
- Kubernetes
- Security
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Kubernetes compliance guide: CIS Kubernetes Benchmark implementation, DISA STIG for Kubernetes, kube-bench automated auditing, Falco compliance monitoring rules, policy-as-code compliance gates in CI/CD, and compliance reporting for auditors."
more_link: "yes"
url: "/kubernetes-compliance-automation-disa-stig-cis-benchmarks/"
---

Enterprise Kubernetes deployments subject to regulatory frameworks — FedRAMP, PCI DSS, HIPAA, or DoD Authorization to Operate — require demonstrable, continuous compliance against established benchmarks. The CIS Kubernetes Benchmark and DISA Security Technical Implementation Guide (STIG) for Kubernetes define hundreds of configuration controls spanning API server hardening, RBAC configuration, network policy, audit logging, and runtime security. Manual auditing against these benchmarks is error-prone and unsustainable. This guide covers the complete automated compliance pipeline from benchmark scanning through CI/CD gates to auditor reporting.

<!--more-->

## Compliance Framework Overview

### CIS Kubernetes Benchmark Structure

The CIS Kubernetes Benchmark (version 1.9 as of this writing) is organized into six major sections:

| Section | Controls | Focus Area |
|---------|----------|------------|
| 1. Control Plane Components | ~30 | API server, controller manager, scheduler flags |
| 2. Etcd | ~9 | etcd authentication, encryption, access controls |
| 3. Control Plane Configuration | ~6 | Audit logs, PKI |
| 4. Worker Nodes | ~20 | kubelet configuration, file permissions |
| 5. Kubernetes Policies | ~35 | RBAC, network policies, Pod Security Standards |
| 6. Managed Services (EKS/GKE/AKS) | ~10 | Cloud-specific controls |

### DISA STIG for Kubernetes

The DISA STIG for Kubernetes (STIG ID: CNTR-K8-000010 through CNTR-K8-003560) maps to the same configuration areas but adds DoD-specific requirements such as mandatory CAC authentication, FIPS 140-2 validated cryptography, and specific audit event categories. Key categories:

- **CAT I (High)**: Unauthorized privileged access to cluster
- **CAT II (Medium)**: Missing authentication, authorization gaps, audit logging deficiencies
- **CAT III (Low)**: Informational findings, recommended improvements

## kube-bench: Automated CIS Benchmark Scanning

kube-bench is the primary tool for automated CIS Kubernetes Benchmark assessment. It runs checks directly on cluster nodes and reports compliance status.

### Deploying kube-bench as a Kubernetes Job

```yaml
# kube-bench-job.yaml
# Runs kube-bench on the master node
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-master
  namespace: kube-system
spec:
  template:
    spec:
      hostPID: true
      hostNetwork: true
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      restartPolicy: Never
      volumes:
      - name: var-lib-etcd
        hostPath:
          path: /var/lib/etcd
      - name: var-lib-kubelet
        hostPath:
          path: /var/lib/kubelet
      - name: var-lib-kube-scheduler
        hostPath:
          path: /var/lib/kube-scheduler
      - name: var-lib-kube-controller-manager
        hostPath:
          path: /var/lib/kube-controller-manager
      - name: etc-systemd
        hostPath:
          path: /etc/systemd
      - name: lib-systemd
        hostPath:
          path: /lib/systemd
      - name: srv-kubernetes
        hostPath:
          path: /srv/kubernetes
      - name: etc-kubernetes
        hostPath:
          path: /etc/kubernetes
      - name: usr-bin
        hostPath:
          path: /usr/bin
      - name: etc-cni-netd
        hostPath:
          path: /etc/cni/net.d/
      - name: opt-cni-bin
        hostPath:
          path: /opt/cni/bin/
      containers:
      - name: kube-bench
        image: docker.io/aquasec/kube-bench:v0.9.0
        command: ["kube-bench", "--json", "--outputfile", "/tmp/kube-bench-results.json"]
        args:
        - "run"
        - "--targets"
        - "master,etcd,policies"
        - "--benchmark"
        - "cis-1.9"
        volumeMounts:
        - name: var-lib-etcd
          mountPath: /var/lib/etcd
          readOnly: true
        - name: var-lib-kubelet
          mountPath: /var/lib/kubelet
          readOnly: true
        - name: var-lib-kube-scheduler
          mountPath: /var/lib/kube-scheduler
          readOnly: true
        - name: var-lib-kube-controller-manager
          mountPath: /var/lib/kube-controller-manager
          readOnly: true
        - name: etc-systemd
          mountPath: /etc/systemd
          readOnly: true
        - name: lib-systemd
          mountPath: /lib/systemd
          readOnly: true
        - name: srv-kubernetes
          mountPath: /srv/kubernetes
          readOnly: true
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
        - name: usr-bin
          mountPath: /usr/local/mount-from-host/bin
          readOnly: true
        - name: etc-cni-netd
          mountPath: /etc/cni/net.d/
          readOnly: true
        - name: opt-cni-bin
          mountPath: /opt/cni/bin/
          readOnly: true
---
# kube-bench-worker.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-node
  namespace: kube-system
spec:
  template:
    spec:
      hostPID: true
      restartPolicy: Never
      containers:
      - name: kube-bench
        image: docker.io/aquasec/kube-bench:v0.9.0
        command: ["kube-bench"]
        args:
        - "run"
        - "--targets"
        - "node"
        - "--benchmark"
        - "cis-1.9"
        - "--json"
        volumeMounts:
        - name: var-lib-kubelet
          mountPath: /var/lib/kubelet
          readOnly: true
        - name: etc-systemd
          mountPath: /etc/systemd
          readOnly: true
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
      volumes:
      - name: var-lib-kubelet
        hostPath:
          path: /var/lib/kubelet
      - name: etc-systemd
        hostPath:
          path: /etc/systemd
      - name: etc-kubernetes
        hostPath:
          path: /etc/kubernetes
```

### Parsing kube-bench Results

```bash
# Run kube-bench and collect results
kubectl apply -f kube-bench-job.yaml
kubectl wait --for=condition=complete job/kube-bench-master -n kube-system --timeout=120s

# Extract JSON results
kubectl logs -n kube-system job/kube-bench-master > /tmp/kube-bench-results.json

# Parse results with jq
# Show all FAIL findings
jq '[.Controls[].tests[].results[] | select(.status == "FAIL") |
     {test_number: .test_number, description: .test_desc, remediation: .remediation}]' \
  /tmp/kube-bench-results.json

# Count by status
jq '[.Controls[].tests[].results[] | .status] |
    group_by(.) | map({status: .[0], count: length})' \
  /tmp/kube-bench-results.json

# Generate CSV for spreadsheet reporting
jq -r '.Controls[].tests[].results[] |
  [.test_number, .status, .test_desc, (.remediation // "" | gsub("\n";" "))] |
  @csv' \
  /tmp/kube-bench-results.json > /tmp/kube-bench-report.csv

# Check for CAT I equivalent failures (scored findings only)
jq '[.Controls[].tests[].results[] |
     select(.status == "FAIL" and .scored == true)] | length' \
  /tmp/kube-bench-results.json
```

### Scheduled Compliance Scanning

```yaml
# kube-bench-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: kube-bench-scheduled
  namespace: kube-system
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: kube-bench
          hostPID: true
          hostNetwork: true
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          restartPolicy: OnFailure
          containers:
          - name: kube-bench
            image: docker.io/aquasec/kube-bench:v0.9.0
            command:
            - /bin/sh
            - -c
            - |
              kube-bench run --targets master,etcd,policies \
                --benchmark cis-1.9 --json > /tmp/results.json
              # Post results to compliance platform
              curl -sf -X POST \
                -H "Authorization: Bearer ${COMPLIANCE_API_TOKEN}" \
                -H "Content-Type: application/json" \
                -d @/tmp/results.json \
                "${COMPLIANCE_PLATFORM_URL}/api/v1/scan-results" || true
            env:
            - name: COMPLIANCE_API_TOKEN
              valueFrom:
                secretKeyRef:
                  name: compliance-platform-credentials
                  key: api-token
            - name: COMPLIANCE_PLATFORM_URL
              value: "https://compliance.internal.example.com"
            # Mount volumes (same as above)
```

## CIS Benchmark Remediation

### API Server Hardening (Section 1.2)

The API server has the most controls. Key remediations:

```yaml
# kube-apiserver configuration for CIS compliance
# Typically managed via kubeadm ClusterConfiguration or static pod manifest

# /etc/kubernetes/manifests/kube-apiserver.yaml additions
spec:
  containers:
  - command:
    - kube-apiserver

    # CIS 1.2.1 — RBAC enabled (default in modern Kubernetes)
    - --authorization-mode=Node,RBAC

    # CIS 1.2.2 — Token authentication disabled (use client certificates or OIDC)
    # Disable if not using static tokens
    # - --token-auth-file=  # Remove this flag entirely

    # CIS 1.2.5 — Anonymous authentication disabled
    - --anonymous-auth=false

    # CIS 1.2.6 — Kubelet TLS certificate verification
    - --kubelet-certificate-authority=/etc/kubernetes/pki/ca.crt
    - --kubelet-client-certificate=/etc/kubernetes/pki/apiserver-kubelet-client.crt
    - --kubelet-client-key=/etc/kubernetes/pki/apiserver-kubelet-client.key

    # CIS 1.2.7 — HTTPS connections only to etcd
    - --etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt
    - --etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt
    - --etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key

    # CIS 1.2.13 — Secure port is set (default 6443)
    - --secure-port=6443
    - --tls-cert-file=/etc/kubernetes/pki/apiserver.crt
    - --tls-private-key-file=/etc/kubernetes/pki/apiserver.key

    # CIS 1.2.14 — TLS 1.2 minimum
    - --tls-min-version=VersionTLS12
    - --tls-cipher-suites=TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384

    # CIS 1.2.19-22 — Admission controllers
    - --enable-admission-plugins=NodeRestriction,PodSecurity,ServiceAccount,LimitRanger,ResourceQuota,DefaultStorageClass,DefaultTolerationSeconds,MutatingAdmissionWebhook,ValidatingAdmissionWebhook
    - --disable-admission-plugins=AlwaysPullImages,NamespaceAutoProvision

    # CIS 1.2.22 — Pod Security Admission (replaces PodSecurityPolicy)
    # Configured via PodSecurity admission plugin above

    # CIS 1.2.25 — Encryption at rest for secrets
    - --encryption-provider-config=/etc/kubernetes/encryption-config.yaml

    # CIS 1.2.27-29 — Audit logging
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=30
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100

    # CIS 1.2.30 — Profiling disabled
    - --profiling=false

    # CIS 1.2.32-33 — Service account tokens
    - --service-account-key-file=/etc/kubernetes/pki/sa.pub
    - --service-account-signing-key-file=/etc/kubernetes/pki/sa.key
    - --service-account-issuer=https://kubernetes.default.svc.cluster.local
```

### etcd Encryption at Rest

```yaml
# /etc/kubernetes/encryption-config.yaml
# CIS 1.2.25 — Encrypt secrets at rest
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  - configmaps
  providers:
  # AES-CBC with PKCS#7 padding (FIPS 140-2 compliant when using OpenSSL)
  - aescbc:
      keys:
      - name: key1
        # Generate key: head -c 32 /dev/urandom | base64
        secret: <base64-encoded-32-byte-aes-key>
  # Identity provider (unencrypted) as fallback for reading old data
  - identity: {}
```

### kubelet CIS Hardening

```yaml
# /var/lib/kubelet/config.yaml — CIS Section 4
# Apply via kubeadm or by editing kubelet ConfigMap
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# CIS 4.2.1 — Anonymous authentication disabled
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
    cacheTTL: 2m
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt

# CIS 4.2.2 — Webhook authorization
authorization:
  mode: Webhook
  webhook:
    cacheAuthorizedTTL: 5m
    cacheUnauthorizedTTL: 30s

# CIS 4.2.3 — Client CA file configured (see above)

# CIS 4.2.4 — Read-only port disabled
readOnlyPort: 0

# CIS 4.2.5 — Streaming connection timeout
streamingConnectionIdleTimeout: 4h

# CIS 4.2.6 — Protection of kernel defaults
protectKernelDefaults: true

# CIS 4.2.7 — makeIPTablesUtilChains
makeIPTablesUtilChains: true

# CIS 4.2.8 — hostname override (avoid if possible)
# hostnameOverride: ""

# CIS 4.2.9 — Event record QPS
eventRecordQPS: 5

# CIS 4.2.10 — TLS cert and key
tlsCertFile: /var/lib/kubelet/pki/kubelet.crt
tlsPrivateKeyFile: /var/lib/kubelet/pki/kubelet.key

# CIS 4.2.11 — Rotate kubelet client certificates
rotateCertificates: true

# CIS 4.2.12-13 — TLS minimum version and cipher suites
tlsMinVersion: VersionTLS12
tlsCipherSuites:
- TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
- TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
- TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305
- TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384

# CIS 4.2.14 — PodSecurity Admission level
# (Configured via namespace labels, not kubelet)
```

## DISA STIG-Specific Controls

DISA STIG for Kubernetes adds several controls beyond CIS:

### STIG-Required Audit Policy

```yaml
# /etc/kubernetes/audit-policy.yaml
# STIG CNTR-K8-000360 through CNTR-K8-000500
apiVersion: audit.k8s.io/v1
kind: Policy
rules:

# STIG CNTR-K8-000380: Log all requests to the Secrets resource at RequestResponse level
- level: RequestResponse
  resources:
  - group: ""
    resources: ["secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

# STIG CNTR-K8-000370: Log authentication and authorization events
- level: Metadata
  nonResourceURLs:
  - "/api*"
  - "/version"
  users: ["system:anonymous"]

# Log all activity from privileged system components
- level: Request
  users:
  - "system:serviceaccount:kube-system:default"
  resources:
  - group: ""
    resources: ["pods", "configmaps", "secrets"]

# Log pod exec and attach (privileged access monitoring)
# STIG CNTR-K8-000420
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach", "pods/portforward"]

# Log RBAC changes
# STIG CNTR-K8-000440
- level: RequestResponse
  resources:
  - group: "rbac.authorization.k8s.io"
    resources:
    - "clusterroles"
    - "clusterrolebindings"
    - "roles"
    - "rolebindings"

# Log namespace operations
- level: RequestResponse
  resources:
  - group: ""
    resources: ["namespaces"]

# Log all other requests at Metadata level
- level: Metadata
  omitStages:
  - RequestReceived
```

### STIG Network Policy Requirements

```yaml
# STIG CNTR-K8-000600 — Network policies must be implemented
# Every namespace must have a default-deny NetworkPolicy

# STIG CNTR-K8-000610 — Namespaces must not allow cross-namespace communication
# unless explicitly configured

# Cluster-level policy enforcement via Kyverno or Gatekeeper to ensure
# every non-system namespace has a default-deny NetworkPolicy

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: stig-require-network-policy
  annotations:
    policies.kyverno.io/title: STIG Network Policy Requirement
    policies.kyverno.io/description: >-
      CNTR-K8-000600: Ensures every production namespace has a default-deny NetworkPolicy.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-default-deny-networkpolicy
    match:
      any:
      - resources:
          kinds:
          - Namespace
          selector:
            matchLabels:
              environment: production
    validate:
      message: "STIG CNTR-K8-000600: Namespace must have a default-deny NetworkPolicy. Create one before creating the namespace."
      deny:
        conditions:
          all:
          - key: "{{ request.operation || 'BACKGROUND' }}"
            operator: NotEquals
            value: DELETE
          # This is handled by a generate rule in the same policy set
```

## Falco Rules for Compliance Monitoring

Falco provides runtime compliance monitoring, detecting conditions that static configuration checks cannot:

```yaml
# /etc/falco/rules.d/compliance-monitoring.yaml
# CIS and STIG runtime compliance rules

- rule: Kubernetes Sensitive File Read by Non-Root
  desc: >
    STIG CNTR-K8-001900 — Detects reading of sensitive Kubernetes files
    by non-root processes, which may indicate unauthorized access.
  condition: >
    open_read and
    fd.name in (kubernetes_sensitive_files) and
    user.uid != 0 and
    not proc.name in (allowed_k8s_readers)
  output: >
    Sensitive Kubernetes file read by non-root process
    (user=%user.name uid=%user.uid command=%proc.cmdline file=%fd.name
    container=%container.name image=%container.image.repository)
  priority: WARNING
  tags: [compliance, stig, CNTR-K8-001900]

- macro: kubernetes_sensitive_files
  condition: >
    fd.name in (
      "/etc/kubernetes/admin.conf",
      "/etc/kubernetes/scheduler.conf",
      "/etc/kubernetes/controller-manager.conf",
      "/var/lib/kubelet/config.yaml",
      "/etc/kubernetes/pki/ca.key",
      "/etc/kubernetes/pki/apiserver.key"
    )

- rule: Write to etcd Data Directory
  desc: >
    CIS 1.1.7-12 — etcd data directory should not be modified directly.
    Direct writes may corrupt cluster state.
  condition: >
    (open_write or mkdir) and
    fd.directory startswith "/var/lib/etcd" and
    not proc.name in ("etcd", "etcdctl")
  output: >
    Direct write to etcd data directory detected
    (user=%user.name command=%proc.cmdline file=%fd.name)
  priority: CRITICAL
  tags: [compliance, cis, CIS-1.1.7]

- rule: Container Running with Privileged Flag
  desc: >
    CIS 5.2.1 — Containers should not run with the privileged flag.
    This grants full host access to the container.
  condition: >
    spawned_process and
    container and
    container.privileged = true and
    not proc.name in (allowed_privileged_processes)
  output: >
    Privileged container detected
    (user=%user.name command=%proc.cmdline container=%container.name
    image=%container.image.repository pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: WARNING
  tags: [compliance, cis, CIS-5.2.1]

- list: allowed_privileged_processes
  items: []
  # Add legitimate privileged processes here:
  # items: ["cilium-agent", "fluentd"]

- rule: Service Account Token Read Outside Expected Paths
  desc: >
    CIS 5.1.6 — Service account tokens should only be read by
    the intended application process.
  condition: >
    open_read and
    container and
    fd.name startswith "/var/run/secrets/kubernetes.io/serviceaccount" and
    not proc.name in (allowed_token_readers)
  output: >
    Service account token read by unexpected process
    (user=%user.name command=%proc.cmdline file=%fd.name
    container=%container.name pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: WARNING
  tags: [compliance, cis, CIS-5.1.6]

- rule: Kubernetes Audit Log File Modified
  desc: >
    STIG CNTR-K8-000380 — Audit log files must not be modified or deleted.
    This indicates potential audit trail tampering.
  condition: >
    (open_write or rename or remove) and
    fd.directory startswith "/var/log/kubernetes/audit"
  output: >
    Kubernetes audit log modification detected
    (user=%user.name command=%proc.cmdline file=%fd.name)
  priority: CRITICAL
  tags: [compliance, stig, CNTR-K8-000380]

- rule: Pod Exec Without Authorization Header
  desc: >
    STIG CNTR-K8-001560 — All kubectl exec operations must be
    authenticated and audited.
  condition: >
    k8s_audit and
    ka.verb = "create" and
    ka.target.resource = "pods/exec" and
    not ka.user.name startswith "system:"
  output: >
    kubectl exec performed (user=%ka.user.name pod=%ka.target.name
    ns=%ka.target.namespace command=%ka.request.object.command)
  priority: NOTICE
  tags: [compliance, stig, CNTR-K8-001560]
```

## Policy-as-Code Compliance Gates in CI/CD

### GitLab CI/CD Compliance Pipeline

```yaml
# .gitlab-ci.yml — Compliance gate stage
stages:
- build
- test
- compliance-gate
- deploy

# Stage: Run Kubernetes manifest compliance checks before deployment
compliance:kyverno-check:
  stage: compliance-gate
  image: ghcr.io/kyverno/kyverno-cli:v1.12.0
  script:
  - |
    kyverno apply /compliance/policies/ \
      --resource kubernetes/manifests/ \
      --detailed-results \
      --output-format json \
      > compliance-results.json

    # Fail the pipeline if any violations found
    VIOLATIONS=$(jq '[.policyReportResults[] | select(.result == "fail")] | length' compliance-results.json)
    if [ "${VIOLATIONS}" -gt 0 ]; then
      echo "COMPLIANCE GATE FAILED: ${VIOLATIONS} policy violations found"
      jq -r '.policyReportResults[] |
        select(.result == "fail") |
        "FAIL: \(.policy)/\(.rule) — \(.resources[0].name): \(.message)"' compliance-results.json
      exit 1
    fi
    echo "Compliance gate passed: 0 violations"
  artifacts:
    reports:
      junit: compliance-results-junit.xml
    paths:
    - compliance-results.json
    when: always
    expire_in: 30 days

compliance:image-scanning:
  stage: compliance-gate
  image: aquasec/trivy:latest
  script:
  - |
    # Scan the built image for CVEs that violate compliance thresholds
    trivy image \
      --exit-code 1 \
      --severity CRITICAL \
      --ignore-unfixed \
      --format json \
      --output trivy-results.json \
      "${CI_REGISTRY_IMAGE}:${CI_COMMIT_SHORT_SHA}"
  artifacts:
    paths:
    - trivy-results.json
    when: always
```

### OPA Conftest for Manifest Validation

```bash
# Install conftest
curl -LO https://github.com/open-policy-agent/conftest/releases/download/v0.55.0/conftest_0.55.0_Linux_x86_64.tar.gz
tar xzvf conftest_0.55.0_Linux_x86_64.tar.gz
sudo install conftest /usr/local/bin/

# policy/cis-5.2.rego — CIS Section 5.2 policies
cat > policy/cis-5.2.rego << 'EOF'
package kubernetes.cis_5_2

import future.keywords.if
import future.keywords.in

# CIS 5.2.1 — Privileged containers not allowed
deny[msg] if {
    input.kind in {"Pod", "Deployment", "StatefulSet", "DaemonSet"}
    container := get_containers(input)[_]
    container.securityContext.privileged == true
    msg := sprintf("CIS 5.2.1: Container '%v' is running as privileged", [container.name])
}

# CIS 5.2.2 — Host PID namespace not shared
deny[msg] if {
    input.kind == "Pod"
    input.spec.hostPID == true
    msg := "CIS 5.2.2: Pod is sharing host PID namespace"
}

deny[msg] if {
    input.kind in {"Deployment", "StatefulSet", "DaemonSet"}
    input.spec.template.spec.hostPID == true
    msg := "CIS 5.2.2: Pod template is sharing host PID namespace"
}

# CIS 5.2.5 — Root containers not allowed
deny[msg] if {
    input.kind in {"Pod", "Deployment", "StatefulSet", "DaemonSet"}
    container := get_containers(input)[_]
    not container_has_run_as_non_root(container)
    msg := sprintf("CIS 5.2.5: Container '%v' does not require non-root user", [container.name])
}

container_has_run_as_non_root(container) if {
    container.securityContext.runAsNonRoot == true
}

container_has_run_as_non_root(container) if {
    container.securityContext.runAsUser > 0
}

# CIS 5.2.6 — No NET_RAW capability
deny[msg] if {
    input.kind in {"Pod", "Deployment", "StatefulSet", "DaemonSet"}
    container := get_containers(input)[_]
    capability := container.securityContext.capabilities.add[_]
    lower(capability) == "net_raw"
    msg := sprintf("CIS 5.2.6: Container '%v' adds NET_RAW capability", [container.name])
}

# CIS 5.2.7 — No privileged capabilities
dangerous_capabilities := {
    "sys_admin", "net_admin", "sys_ptrace", "sys_module",
    "dac_override", "dac_read_search", "net_raw"
}

deny[msg] if {
    input.kind in {"Pod", "Deployment", "StatefulSet", "DaemonSet"}
    container := get_containers(input)[_]
    capability := container.securityContext.capabilities.add[_]
    lower(capability) in dangerous_capabilities
    msg := sprintf("CIS 5.2.7: Container '%v' adds dangerous capability %v",
        [container.name, capability])
}

# Helper: get all containers from any workload kind
get_containers(resource) = containers if {
    resource.kind == "Pod"
    containers := resource.spec.containers
}

get_containers(resource) = containers if {
    resource.kind in {"Deployment", "StatefulSet", "DaemonSet"}
    containers := resource.spec.template.spec.containers
}
EOF

# Run conftest against Kubernetes manifests
conftest test \
  --policy policy/ \
  --namespace kubernetes.cis_5_2 \
  kubernetes/manifests/*.yaml

# Example output:
# FAIL - kubernetes/manifests/api-deployment.yaml - CIS 5.2.5: Container 'api' does not require non-root user
# FAIL - kubernetes/manifests/api-deployment.yaml - CIS 5.2.7: Container 'api' adds dangerous capability SYS_ADMIN
# 2 tests, 0 passed, 0 warnings, 2 failures
```

## Compliance Reporting

### Generating Auditor Reports

```bash
#!/bin/bash
# /usr/local/sbin/generate-compliance-report.sh
# Generate HTML compliance report from kube-bench results

set -euo pipefail

RESULTS_FILE="${1:-/tmp/kube-bench-results.json}"
REPORT_FILE="/tmp/compliance-report-$(date +%Y%m%d).html"

cat > "${REPORT_FILE}" << 'HTMLEOF'
<!DOCTYPE html>
<html>
<head>
    <title>Kubernetes CIS Benchmark Compliance Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #4472C4; color: white; }
        .PASS { color: green; font-weight: bold; }
        .FAIL { color: red; font-weight: bold; }
        .WARN { color: orange; font-weight: bold; }
        .INFO { color: blue; }
        .summary { margin: 20px 0; padding: 15px; background: #f5f5f5; }
    </style>
</head>
<body>
HTMLEOF

# Add report metadata
echo "<h1>CIS Kubernetes Benchmark Compliance Report</h1>" >> "${REPORT_FILE}"
echo "<p>Generated: $(date '+%Y-%m-%d %H:%M:%S UTC')</p>" >> "${REPORT_FILE}"
echo "<p>Cluster: ${CLUSTER_NAME:-unknown}</p>" >> "${REPORT_FILE}"
echo "<p>Benchmark: CIS Kubernetes Benchmark v1.9</p>" >> "${REPORT_FILE}"

# Generate summary statistics
PASS_COUNT=$(jq '[.Controls[].tests[].results[] | select(.status == "PASS")] | length' "${RESULTS_FILE}")
FAIL_COUNT=$(jq '[.Controls[].tests[].results[] | select(.status == "FAIL")] | length' "${RESULTS_FILE}")
WARN_COUNT=$(jq '[.Controls[].tests[].results[] | select(.status == "WARN")] | length' "${RESULTS_FILE}")
INFO_COUNT=$(jq '[.Controls[].tests[].results[] | select(.status == "INFO")] | length' "${RESULTS_FILE}")
TOTAL=$((PASS_COUNT + FAIL_COUNT + WARN_COUNT + INFO_COUNT))
COMPLIANCE_PCT=$(echo "scale=1; ${PASS_COUNT} * 100 / ${TOTAL}" | bc)

cat >> "${REPORT_FILE}" << HTML
<div class="summary">
    <h2>Summary</h2>
    <p>Overall Compliance: <strong>${COMPLIANCE_PCT}%</strong></p>
    <p><span class="PASS">PASS: ${PASS_COUNT}</span> |
       <span class="FAIL">FAIL: ${FAIL_COUNT}</span> |
       <span class="WARN">WARN: ${WARN_COUNT}</span> |
       <span class="INFO">INFO: ${INFO_COUNT}</span></p>
    <p>Total Controls Evaluated: ${TOTAL}</p>
</div>
HTML

# Generate findings table
echo '<h2>Failed Controls</h2>' >> "${REPORT_FILE}"
echo '<table><tr><th>Control</th><th>Status</th><th>Description</th><th>Remediation</th></tr>' >> "${REPORT_FILE}"

jq -r '.Controls[].tests[].results[] |
  select(.status == "FAIL") |
  "<tr><td>" + .test_number + "</td><td class=\"FAIL\">" + .status +
  "</td><td>" + .test_desc + "</td><td>" +
  (.remediation // "No remediation available" | gsub("\n";"<br>")) +
  "</td></tr>"' "${RESULTS_FILE}" >> "${REPORT_FILE}"

echo '</table></body></html>' >> "${REPORT_FILE}"

echo "Report generated: ${REPORT_FILE}"
echo "Compliance: ${COMPLIANCE_PCT}% (${PASS_COUNT}/${TOTAL} controls passing)"
```

## Summary

Kubernetes compliance automation transforms the assessment of hundreds of benchmark controls from a periodic manual process into a continuous, automated pipeline:

- **kube-bench**: Automated daily CIS benchmark scanning deployed as Kubernetes Jobs with JSON output for pipeline integration and reporting
- **API server hardening**: Configuration flags for disabling anonymous auth, enabling RBAC, TLS hardening, and encryption-at-rest covering the majority of CIS Section 1.2 controls
- **kubelet hardening**: Authentication, authorization, and TLS configuration satisfying CIS Section 4.2
- **STIG-specific controls**: Comprehensive audit policy and network policy enforcement satisfying DoD CNTR-K8 controls
- **Falco runtime monitoring**: Detection of compliance violations at runtime that static configuration checks cannot catch
- **CI/CD gates**: Kyverno CLI and OPA conftest provide pre-deployment policy validation, blocking non-compliant manifests before they reach the cluster
- **Automated reporting**: Script-driven HTML report generation with compliance percentage and remediation guidance for auditors

The combination of preventive controls (admission policies), detective controls (kube-bench, Falco), and automated reporting creates a defensible compliance posture that satisfies audit requirements while minimizing manual effort.
