---
title: "Kubernetes Compliance: SOC2 and PCI-DSS Controls for Container Workloads"
date: 2027-07-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Compliance", "SOC2", "PCI-DSS", "Security", "Audit"]
categories:
- Security
- Kubernetes
- Compliance
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-ready guide to achieving SOC2 Type II and PCI-DSS compliance for Kubernetes container workloads, covering access controls, audit logging, network segmentation, secret management, OPA policy enforcement, automated evidence collection, and CIS Kubernetes Benchmark scoring."
more_link: "yes"
url: "/kubernetes-compliance-soc2-pci-guide/"
---

Regulatory compliance in Kubernetes environments demands more than checkbox audits. SOC2 Type II and PCI-DSS require continuous control operation, auditable evidence, and demonstrable security posture across the entire container lifecycle. This guide provides production-grade implementations for each control domain, from network segmentation and audit logging to compliance-as-code with OPA and automated evidence collection pipelines.

<!--more-->

# [Kubernetes Compliance: SOC2 and PCI-DSS Controls for Container Workloads](#kubernetes-compliance-soc2-pci-guide)

## Section 1: SOC2 Type II Control Mapping for Kubernetes

SOC2 Type II evaluates whether controls are operating effectively over a period (typically 6–12 months). The five Trust Service Criteria (TSC) map directly to Kubernetes primitives:

| TSC | Control Domain | Kubernetes Mechanism |
|---|---|---|
| CC6.1 | Logical access controls | RBAC, OIDC integration |
| CC6.6 | Network segmentation | NetworkPolicy, mTLS |
| CC6.7 | Encryption at rest/transit | etcd encryption, TLS |
| CC7.2 | Monitoring and alerting | Prometheus, Falco |
| CC8.1 | Change management | GitOps, admission webhooks |
| A1.1 | Availability | HPA, PDB, multi-AZ |

### CC6.1 — RBAC Implementation

```yaml
# rbac/platform-roles.yaml
# Principle of least privilege RBAC structure
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: developer-readonly
  labels:
    compliance.soc2/control: CC6.1
    compliance.pci/requirement: "7.1"
rules:
- apiGroups: [""]
  resources: ["pods", "services", "configmaps", "events"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets", "statefulsets"]
  verbs: ["get", "list", "watch"]
# Explicitly deny secrets access
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: developer-namespace-admin
  labels:
    compliance.soc2/control: CC6.1
rules:
- apiGroups: [""]
  resources: ["pods", "services", "configmaps", "persistentvolumeclaims"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets", "daemonsets"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
# Secrets access is explicitly excluded
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: sre-operator
  labels:
    compliance.soc2/control: CC6.1
rules:
- apiGroups: [""]
  resources: ["*"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: ["apps", "batch", "autoscaling"]
  resources: ["*"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
# Nodes and cluster-level resources require ClusterAdmin
---
# Time-limited privileged access via CronJob cleanup
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: emergency-admin-binding
  labels:
    compliance.soc2/control: CC6.1
    access.type: break-glass
    expires: "2027-07-31T18:00:00Z"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: User
  name: oncall-engineer@support.tools
  apiGroup: rbac.authorization.k8s.io
```

### OIDC Integration for Identity Federation

```yaml
# kube-apiserver flags (kubeadm ClusterConfiguration)
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
apiServer:
  extraArgs:
    oidc-issuer-url: "https://sso.support.tools/auth/realms/platform"
    oidc-client-id: "kubernetes"
    oidc-username-claim: "email"
    oidc-groups-claim: "groups"
    oidc-username-prefix: "sso:"
    oidc-groups-prefix: "sso:"
    audit-log-path: "/var/log/kubernetes/audit.log"
    audit-log-maxage: "90"
    audit-log-maxbackup: "10"
    audit-log-maxsize: "100"
    audit-policy-file: "/etc/kubernetes/audit-policy.yaml"
```

---

## Section 2: Audit Log Forwarding

Audit logs are the primary evidence artifact for both SOC2 and PCI-DSS. Every privileged action, secret access, and RBAC change must be captured and forwarded to an immutable store.

### Audit Policy Configuration

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
# Log all secret access at the Request level (body redacted)
- level: Request
  resources:
  - group: ""
    resources: ["secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

# Log RBAC changes at RequestResponse level
- level: RequestResponse
  resources:
  - group: "rbac.authorization.k8s.io"
    resources:
    - clusterroles
    - clusterrolebindings
    - roles
    - rolebindings
  verbs: ["create", "update", "patch", "delete"]

# Log exec and port-forward (privileged interactive access)
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods/exec", "pods/portforward", "pods/log"]
  verbs: ["create"]

# Log authentication failures
- level: Metadata
  omitStages: ["RequestReceived"]
  users: []
  nonResourceURLs:
  - "/api*"
  - "/version"
  verbs: ["get", "post"]

# Metadata level for read operations on most resources
- level: Metadata
  omitStages: ["RequestReceived"]
  resources:
  - group: ""
    resources: ["nodes", "services", "endpoints", "namespaces"]
  - group: "apps"
    resources: ["deployments", "daemonsets", "statefulsets"]

# None for high-volume low-risk endpoints
- level: None
  users: ["system:kube-scheduler", "system:kube-controller-manager"]
  verbs: ["get", "list", "watch"]

- level: None
  nonResourceURLs:
  - "/healthz*"
  - "/readyz*"
  - "/livez*"
  - "/metrics"
```

### Fluent Bit Audit Log Forwarder

```yaml
# fluentbit/audit-log-forwarder.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentbit-audit-config
  namespace: kube-system
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Daemon        Off
        Log_Level     info
        Parsers_File  parsers.conf

    [INPUT]
        Name              tail
        Path              /var/log/kubernetes/audit.log
        Parser            json
        Tag               audit.*
        Refresh_Interval  5
        Mem_Buf_Limit     50MB
        Skip_Long_Lines   On

    [FILTER]
        Name  record_modifier
        Match audit.*
        Record cluster_name production-us-east-1
        Record compliance_source kubernetes-audit

    # Enrich with user identity
    [FILTER]
        Name  lua
        Match audit.*
        script enrichment.lua
        call  enrich_audit_event

    [OUTPUT]
        Name              s3
        Match             audit.*
        bucket            compliance-audit-logs-immutable
        region            us-east-1
        prefix_key        kubernetes/audit/
        s3_key_format     /kubernetes/audit/%Y/%m/%d/audit.%H%M%S.log.gz
        compression       gzip
        use_put_object    On
        storage_class     GLACIER_IR

    # Simultaneously forward to SIEM
    [OUTPUT]
        Name        http
        Match       audit.*
        Host        siem.support.tools
        Port        8088
        URI         /services/collector/event
        Format      json
        Header      Authorization Bearer SIEM_TOKEN_REPLACE_ME
        tls         On
        tls.verify  On
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluentbit-audit
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: fluentbit-audit
  template:
    metadata:
      labels:
        app: fluentbit-audit
    spec:
      serviceAccountName: fluentbit
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      containers:
      - name: fluentbit
        image: fluent/fluent-bit:3.1.0
        volumeMounts:
        - name: audit-logs
          mountPath: /var/log/kubernetes
          readOnly: true
        - name: config
          mountPath: /fluent-bit/etc/
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 200m
            memory: 256Mi
      volumes:
      - name: audit-logs
        hostPath:
          path: /var/log/kubernetes
          type: DirectoryOrCreate
      - name: config
        configMap:
          name: fluentbit-audit-config
```

---

## Section 3: PCI-DSS Requirements for Kubernetes

PCI-DSS v4.0 introduces explicit requirements for containerized environments. Key requirements with Kubernetes implementations:

| PCI Req | Description | Kubernetes Control |
|---|---|---|
| 1.3 | Network access controls | NetworkPolicy, Cilium policies |
| 2.2 | System hardening | CIS Benchmark, PodSecurity |
| 3.5 | Encryption of stored PAN | etcd encryption, sealed secrets |
| 4.2 | Encryption of transmitted PAN | mTLS via Istio/Linkerd |
| 7.1 | Restrict access by need to know | RBAC, namespace isolation |
| 8.3 | Strong authentication | OIDC MFA, service account tokens |
| 10.2 | Audit log generation | API server audit policy |
| 10.5 | Audit log protection | Immutable S3, WORM storage |
| 11.3 | Penetration testing | Falco, kube-bench, kube-hunter |

### Requirement 1.3 — Network Segmentation for Cardholder Data Environment (CDE)

```yaml
# network-policy/cde-isolation.yaml
# Isolate the Cardholder Data Environment namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cde-default-deny
  namespace: cde
  labels:
    pci.requirement: "1.3"
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
# Allow only approved ingress from payment gateway namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cde-allow-payment-gateway
  namespace: cde
  labels:
    pci.requirement: "1.3"
spec:
  podSelector:
    matchLabels:
      app: payment-processor
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          pci.zone: payment-gateway
    - podSelector:
        matchLabels:
          app: gateway-proxy
    ports:
    - protocol: TCP
      port: 8443
---
# Egress: only to approved payment networks and DNS
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cde-allow-egress-approved
  namespace: cde
  labels:
    pci.requirement: "1.3"
spec:
  podSelector:
    matchLabels:
      app: payment-processor
  policyTypes:
  - Egress
  egress:
  # DNS resolution
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53
  # Payment network (Visa/Mastercard acquirer)
  - to:
    - ipBlock:
        cidr: 192.0.2.0/24
    ports:
    - protocol: TCP
      port: 443
```

### Requirement 2.2 — PodSecurity Standards for CDE

```yaml
# namespace/cde-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cde
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.30
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.30
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.30
    pci.environment: cde
    pci.requirement: "2.2"
```

```yaml
# pod-security/cde-pod-spec.yaml
# Compliant pod spec for CDE workloads
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: cde
  labels:
    pci.requirement: "2.2"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-processor
  template:
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 10000
        runAsGroup: 10000
        fsGroup: 10000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: payment-processor
        image: registry.support.tools/payment-processor:1.0.0
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 1Gi
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: var-run
          mountPath: /var/run
      volumes:
      - name: tmp
        emptyDir: {}
      - name: var-run
        emptyDir: {}
```

---

## Section 4: Secret Management for PCI Compliance

### etcd Encryption at Rest (Requirement 3.5)

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  - configmaps
  providers:
  # AES-GCM with key rotation support
  - aescbc:
      keys:
      - name: key-2027-q3
        secret: BASE64_ENCODED_32_BYTE_KEY_REPLACE_ME
      - name: key-2027-q2
        secret: BASE64_ENCODED_32_BYTE_KEY_PREVIOUS_REPLACE_ME
  # Fallback identity provider (no encryption)
  - identity: {}
```

```bash
# Verify secrets are encrypted in etcd
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/cde/payment-processor-creds | \
  hexdump -C | head -5

# Output should show "k8s:enc:aescbc:v1:key-2027-q3" prefix
# NOT the plaintext secret value
```

### Key Rotation Procedure

```bash
#!/bin/bash
# rotate-etcd-encryption-key.sh
# PCI Req 3.5.1: Cryptographic key rotation

set -euo pipefail

NEW_KEY=$(openssl rand -base64 32)
NEW_KEY_NAME="key-$(date +%Y-%m)"

echo "Step 1: Add new key to encryption config (prepend, keep old key)"
# Update /etc/kubernetes/encryption-config.yaml to prepend new key
# Old key remains as second entry for decryption of existing data

echo "Step 2: Restart kube-apiserver on all control plane nodes"
# Rolling restart of kube-apiserver picks up new config

echo "Step 3: Force re-encryption of all secrets with new key"
kubectl get secrets --all-namespaces -o json | \
  kubectl replace -f -

echo "Step 4: Remove old key from encryption config after verification"
echo "Step 5: Restart kube-apiserver again to use only new key"
echo "New key (store in vault): ${NEW_KEY_NAME}"
```

---

## Section 5: Compliance as Code with OPA Gatekeeper

### CIS Kubernetes Benchmark Controls as OPA Policies

```yaml
# opa-constraints/cis-5.1.1-no-privileged-containers.yaml
# CIS 5.1.1: Do not admit privileged containers
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPPrivilegedContainer
metadata:
  name: psp-privileged-container
  labels:
    compliance.cis: "5.1.1"
    compliance.pci: "2.2"
    compliance.soc2: "CC6.6"
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    excludedNamespaces:
    - kube-system
    - cert-manager
```

```yaml
# opa-constraints/pci-req10-audit-logging.yaml
# PCI Req 10: Ensure audit logging is configured
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequireauditlabel
  labels:
    compliance.pci: "10.2"
spec:
  crd:
    spec:
      names:
        kind: K8sRequireAuditLabel
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequireauditlabel

      violation[{"msg": msg}] {
        input.review.kind.kind == "Namespace"
        not input.review.object.metadata.labels["audit.pci/enabled"]
        not input.review.object.metadata.labels["kubernetes.io/metadata.name"] == "kube-system"
        msg := sprintf(
          "Namespace %v must have label audit.pci/enabled=true for PCI compliance",
          [input.review.object.metadata.name]
        )
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireAuditLabel
metadata:
  name: require-pci-audit-label
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Namespace"]
```

### PCI Image Registry Constraint

```yaml
# opa-constraints/pci-approved-registries.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sapprovedregistries
  labels:
    compliance.pci: "6.3"
    compliance.soc2: "CC8.1"
spec:
  crd:
    spec:
      names:
        kind: K8sApprovedRegistries
      validation:
        openAPIV3Schema:
          properties:
            allowedRegistries:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8sapprovedregistries

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not starts_with_approved(container.image)
        msg := sprintf(
          "Container image %v must be from an approved registry",
          [container.image]
        )
      }

      starts_with_approved(image) {
        approved := input.parameters.allowedRegistries[_]
        startswith(image, approved)
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sApprovedRegistries
metadata:
  name: approved-registries
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    namespaces:
    - cde
    - production
  parameters:
    allowedRegistries:
    - "registry.support.tools/"
    - "gcr.io/distroless/"
```

---

## Section 6: Automated Evidence Collection

SOC2 Type II requires evidence that controls operated continuously over the audit period. Manual evidence collection is error-prone and time-consuming — automation is essential.

### Evidence Collection CronJob

```yaml
# evidence-collection/cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: compliance-evidence-collector
  namespace: compliance
spec:
  schedule: "0 6 * * *"   # Daily at 06:00 UTC
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: evidence-collector
          restartPolicy: OnFailure
          containers:
          - name: collector
            image: registry.support.tools/compliance-tools:1.0.0
            env:
            - name: EVIDENCE_BUCKET
              value: compliance-evidence-soc2
            - name: CLUSTER_NAME
              value: production-us-east-1
            command:
            - /bin/sh
            - -c
            - |
              DATE=$(date +%Y-%m-%d)
              EVIDENCE_PATH="s3://${EVIDENCE_BUCKET}/${CLUSTER_NAME}/${DATE}"

              echo "=== Collecting RBAC Evidence (CC6.1) ==="
              kubectl get clusterrolebindings -o json \
                > /tmp/clusterrolebindings.json
              kubectl get rolebindings --all-namespaces -o json \
                > /tmp/rolebindings.json

              echo "=== Collecting Network Policy Evidence (CC6.6) ==="
              kubectl get networkpolicies --all-namespaces -o json \
                > /tmp/networkpolicies.json

              echo "=== Collecting PodSecurity Evidence (CC6.6) ==="
              kubectl get namespaces -o json \
                > /tmp/namespaces-security-labels.json

              echo "=== Collecting Node Configuration Evidence (CC6.7) ==="
              kubectl get nodes -o json > /tmp/nodes.json

              echo "=== Running CIS Benchmark ==="
              kube-bench run --json > /tmp/cis-benchmark.json

              echo "=== Collecting Secret Count (PCI 3.5) ==="
              kubectl get secrets --all-namespaces \
                --field-selector type!=kubernetes.io/service-account-token \
                -o json | jq '[.items[] | {name:.metadata.name, namespace:.metadata.namespace, type:.type, created:.metadata.creationTimestamp}]' \
                > /tmp/secrets-inventory.json

              echo "=== Uploading Evidence ==="
              aws s3 cp /tmp/ "${EVIDENCE_PATH}/" --recursive --no-progress

              echo "=== Evidence collection complete: ${EVIDENCE_PATH} ==="
```

### RBAC ServiceAccount for Evidence Collector

```yaml
# evidence-collection/rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: evidence-collector
  namespace: compliance
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: evidence-collector
rules:
- apiGroups: [""]
  resources:
  - namespaces
  - nodes
  - pods
  - services
  - serviceaccounts
  verbs: ["get", "list"]
- apiGroups: ["rbac.authorization.k8s.io"]
  resources:
  - clusterroles
  - clusterrolebindings
  - roles
  - rolebindings
  verbs: ["get", "list"]
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["get", "list"]
- apiGroups: ["policy"]
  resources: ["podsecuritypolicies"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: evidence-collector
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: evidence-collector
subjects:
- kind: ServiceAccount
  name: evidence-collector
  namespace: compliance
```

---

## Section 7: CIS Kubernetes Benchmark Scoring

### kube-bench Deployment

```yaml
# kube-bench/job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench
  namespace: compliance
spec:
  template:
    spec:
      hostPID: true
      nodeSelector:
        kubernetes.io/role: master
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      containers:
      - name: kube-bench
        image: aquasec/kube-bench:0.8.0
        command: ["kube-bench", "run", "--targets", "master,node,etcd,policies", "--json"]
        volumeMounts:
        - name: var-lib-kubelet
          mountPath: /var/lib/kubelet
          readOnly: true
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
        - name: etc-systemd
          mountPath: /etc/systemd
          readOnly: true
        - name: usr-bin
          mountPath: /usr/local/mount-from-host/bin
          readOnly: true
      restartPolicy: Never
      volumes:
      - name: var-lib-kubelet
        hostPath:
          path: /var/lib/kubelet
      - name: etc-kubernetes
        hostPath:
          path: /etc/kubernetes
      - name: etc-systemd
        hostPath:
          path: /etc/systemd
      - name: usr-bin
        hostPath:
          path: /usr/bin
```

```bash
# Parse kube-bench results and generate compliance report
kubectl logs job/kube-bench -n compliance | jq '
  .Controls[] |
  {
    section: .id,
    description: .text,
    pass: [.tests[].results[] | select(.status == "PASS")] | length,
    fail: [.tests[].results[] | select(.status == "FAIL")] | length,
    warn: [.tests[].results[] | select(.status == "WARN")] | length
  }
' > cis-summary.json

# Generate compliance score
jq '
  {
    total_checks: ([.[] | .pass + .fail + .warn] | add),
    passed: ([.[] | .pass] | add),
    failed: ([.[] | .fail] | add),
    score_percent: (([.[] | .pass] | add) / ([.[] | .pass + .fail + .warn] | add) * 100)
  }
' cis-summary.json
```

---

## Section 8: Privileged Access Workstation (PAW) Workflows

SOC2 CC6.1 and PCI Requirement 8.3 require that privileged access to production systems occurs from hardened, audited workstations.

### kubectl Audit Plugin

```bash
#!/bin/bash
# kubectl-audit-plugin
# Installed as kubectl-audit, invoked as: kubectl audit <command>
# Logs all privileged kubectl commands to central audit store

COMMAND="$*"
USER=$(kubectl config current-context | xargs kubectl config view --context= -o jsonpath='{.users[0].user.username}' 2>/dev/null || echo "$(whoami)")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
CLUSTER=$(kubectl config current-context)

# Classify command risk
RISK="low"
echo "${COMMAND}" | grep -qE "exec|port-forward|delete|patch|create secret" && RISK="high"
echo "${COMMAND}" | grep -qE "cluster-admin|clusterrolebinding" && RISK="critical"

# Log to audit endpoint
curl -s -X POST https://audit.support.tools/kubectl \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/.kube/audit-token)" \
  -d "{
    \"timestamp\": \"${TIMESTAMP}\",
    \"user\": \"${USER}\",
    \"cluster\": \"${CLUSTER}\",
    \"command\": \"kubectl ${COMMAND}\",
    \"risk_level\": \"${RISK}\",
    \"workstation\": \"$(hostname)\"
  }" > /dev/null

# Execute the actual command
exec kubectl "${@}"
```

---

## Section 9: Container Penetration Testing

### kube-hunter Job

```yaml
# pentest/kube-hunter-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-hunter
  namespace: security-testing
spec:
  template:
    spec:
      serviceAccountName: kube-hunter-sa
      containers:
      - name: kube-hunter
        image: aquasec/kube-hunter:0.6.8
        args:
        - --pod
        - --report=json
        - --log=none
      restartPolicy: Never
```

```bash
# Trivy cluster scanning for vulnerability assessment
trivy k8s \
  --report=summary \
  --compliance=pci-dss-4 \
  --namespace production \
  --output trivy-pci-report.json \
  cluster

# Parse compliance failures
jq '.Results[] | select(.MisconfSummary.Failures > 0) |
  {
    target: .Target,
    failures: .MisconfSummary.Failures,
    controls: [.Misconfigurations[] | select(.Status == "FAIL") |
      {id: .ID, title: .Title, severity: .Severity}]
  }' trivy-pci-report.json
```

---

## Section 10: Compliance Dashboard and Reporting

### Falco Runtime Security for PCI Req 10.2

```yaml
# falco/falco-rules-pci.yaml
- rule: PCI Privileged Shell Spawned
  desc: >
    PCI Req 10.2.7: A shell was spawned in a container with elevated privileges.
  condition: >
    spawned_process
    and container
    and shell_procs
    and proc.pname in (container_entrypoints)
    and not user_known_shell_spawn_activities
  output: >
    Shell spawned in container (
    pci_req=10.2.7,
    user=%user.name,
    container=%container.name,
    namespace=%k8s.ns.name,
    image=%container.image.repository:%container.image.tag,
    shell=%proc.name,
    parent=%proc.pname,
    cmdline=%proc.cmdline
    )
  priority: CRITICAL
  tags: [pci, container, shell, compliance]

- rule: PCI Secret File Access
  desc: >
    PCI Req 10.2.4: Unauthorized access to secret/credential files.
  condition: >
    open_read
    and container
    and (
      fd.name pmatch (/etc/shadow, /etc/passwd, /var/run/secrets/*)
    )
    and not proc.name in (known_safe_readers)
  output: >
    Secret file access detected (
    pci_req=10.2.4,
    user=%user.name,
    file=%fd.name,
    container=%container.name,
    namespace=%k8s.ns.name
    )
  priority: WARNING
  tags: [pci, secret, file, compliance]
```

### Compliance Metrics Exporter

```yaml
# compliance-exporter/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: compliance-exporter
  namespace: compliance
spec:
  replicas: 1
  selector:
    matchLabels:
      app: compliance-exporter
  template:
    spec:
      serviceAccountName: evidence-collector
      containers:
      - name: exporter
        image: registry.support.tools/compliance-exporter:1.0.0
        ports:
        - name: metrics
          containerPort: 9099
        env:
        - name: CLUSTER_NAME
          value: production-us-east-1
        - name: SCRAPE_INTERVAL
          value: "300"
```

```promql
# Grafana queries for compliance dashboard

# Percentage of namespaces with PodSecurity restricted
sum(kube_namespace_labels{
  label_pod_security_kubernetes_io_enforce="restricted"
}) / sum(kube_namespace_labels{label_pci_environment="cde"}) * 100

# Number of RBAC ClusterRoleBindings to cluster-admin
count(
  kube_clusterrolebinding_info{role_name="cluster-admin"}
)

# CIS benchmark score (requires custom exporter)
cis_benchmark_score{cluster="production-us-east-1", section="master"}

# OPA constraint violations
sum(gatekeeper_violations) by (constraint_kind, namespace)
```

---

## Summary

Achieving and maintaining SOC2 Type II and PCI-DSS compliance in Kubernetes environments requires a layered approach: precise access controls enforced by RBAC and OIDC, comprehensive audit logging forwarded to immutable stores, network segmentation through NetworkPolicy, encryption of secrets in etcd, and policy enforcement through OPA Gatekeeper. Critically, compliance must be treated as a continuous engineering discipline rather than a point-in-time audit. Automated evidence collection, CIS benchmark scoring, and runtime threat detection with Falco provide the operational foundation for demonstrating control effectiveness to auditors throughout the full assessment period.
