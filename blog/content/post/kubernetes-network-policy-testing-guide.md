---
title: "Kubernetes NetworkPolicy Testing: Automated Validation and Visualization"
date: 2028-03-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NetworkPolicy", "Security", "Cyclonus", "Cilium", "Network Testing", "Zero Trust"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Kubernetes NetworkPolicy testing covering cyclonus simulation, netassert validation, Inspektor Gadget tracing, policy visualization, CI integration, and Cilium NetworkPolicy tools."
more_link: "yes"
url: "/kubernetes-network-policy-testing-guide/"
---

NetworkPolicies are among the most error-prone Kubernetes resources to write and maintain: a missing egress rule silently breaks DNS resolution, a label selector typo leaves ports wide open, and policies accumulate over time without anyone knowing which ones are still necessary. Automated testing transforms this brittle situation into a verifiable, auditable security baseline. This guide covers the toolchain for simulating, validating, visualizing, and continuously testing Kubernetes NetworkPolicies in CI pipelines.

<!--more-->

## Why Manual NetworkPolicy Review Fails

NetworkPolicies operate at the intersection of namespace labels, pod labels, port numbers, and protocol specifications. The combinatorial explosion of source/destination pairs makes manual auditing impractical:

- A cluster with 20 namespaces and 5 pods each has 400 possible pod-to-pod communication pairs per port
- Default-deny policies have cascading effects that are non-obvious from reading YAML
- CNI plugins implement the spec with subtle differences (Calico vs Cilium vs Canal handle SCTP differently)
- Policies compound: multiple policies applying to the same pod require understanding union semantics

Automated testing converts "does this policy do what we think?" from a mental model exercise to a pass/fail assertion.

## Cyclonus Network Policy Simulator

Cyclonus systematically tests every combination of source pod, destination pod, and port for a given set of NetworkPolicies, producing a truth table of allowed vs denied connections.

### Installation

```bash
# Install cyclonus as a kubectl plugin via krew
kubectl krew install cyclonus

# Or run directly from the container
kubectl run cyclonus \
  --image=mfenwick100/cyclonus:v0.5.1 \
  --restart=Never \
  -n default \
  --command -- /bin/sh -c "sleep 3600"
```

### Running a Full Policy Simulation

```bash
# Test all NetworkPolicies in a namespace
kubectl cyclonus \
  --namespaces=production \
  --include-pods-in-namespaces=production,shared-services \
  --noisy=false \
  --output-format=table \
  2>/dev/null

# Test policies from a YAML file without a live cluster (dry-run simulation)
kubectl cyclonus \
  --policy-source=file \
  --namespaces-from-file=testdata/namespaces.json \
  --network-policies-from-file=testdata/policies.yaml \
  --noisy=false
```

### Interpreting Cyclonus Output

```
+-----------------------+---------------------------+---------+
| Source               | Destination                | Allowed |
+-----------------------+---------------------------+---------+
| production/frontend  | production/backend:8080    | true    |
| production/frontend  | production/database:5432   | false   |
| production/backend   | production/database:5432   | true    |
| external/unknown     | production/frontend:80     | true    |
| external/unknown     | production/backend:8080    | false   |
+-----------------------+---------------------------+---------+
```

### Generating an Expected Truth Table for CI

```bash
#!/bin/bash
# generate-policy-truth-table.sh
# Creates a truth table for the current state of policies
# Run this when policies are known-good, commit to git, and compare in CI

NAMESPACE=${1:-production}
OUTPUT_FILE="testdata/network-policy-truth-table-${NAMESPACE}.json"

kubectl cyclonus \
  --namespaces="${NAMESPACE}" \
  --output-format=json \
  > "${OUTPUT_FILE}"

echo "Truth table saved to ${OUTPUT_FILE}"
echo "Commit this file and use it as the baseline for CI comparison"
```

Compare against baseline in CI:

```bash
#!/bin/bash
# ci-validate-policies.sh

NAMESPACE=${1:-production}
BASELINE="testdata/network-policy-truth-table-${NAMESPACE}.json"
CURRENT=$(mktemp)

kubectl cyclonus \
  --namespaces="${NAMESPACE}" \
  --output-format=json \
  > "${CURRENT}"

if diff -u "${BASELINE}" "${CURRENT}" > /dev/null 2>&1; then
  echo "Network policy validation PASSED — no changes detected"
  rm -f "${CURRENT}"
  exit 0
else
  echo "Network policy validation FAILED — policy behavior changed"
  echo ""
  echo "Diff (baseline vs current):"
  diff -u "${BASELINE}" "${CURRENT}"
  rm -f "${CURRENT}"
  exit 1
fi
```

## netassert for Live Policy Testing

netassert runs actual network connectivity tests between real pods to validate that NetworkPolicies behave as expected in the live cluster.

### Installation

```bash
# Install netassert as a Go binary
go install github.com/controlplaneio/netassert/v2/cmd/netassert@latest

# Or use the container image
docker pull controlplane/netassert:latest
```

### Writing netassert Test Cases

```yaml
# netassert-tests.yaml
version: "2"
tests:
  - name: "frontend can reach backend API"
    from:
      pod:
        name: frontend
        namespace: production
    to:
      pod:
        name: backend
        namespace: production
    port: 8080
    protocol: tcp
    expect: pass

  - name: "frontend cannot reach database directly"
    from:
      pod:
        name: frontend
        namespace: production
    to:
      pod:
        name: postgres
        namespace: production
    port: 5432
    protocol: tcp
    expect: fail

  - name: "backend can reach external payment API"
    from:
      pod:
        name: backend
        namespace: production
    to:
      host: api.payment-provider.example.com
      ip: 203.0.113.10
    port: 443
    protocol: tcp
    expect: pass

  - name: "staging cannot reach production"
    from:
      pod:
        name: api
        namespace: staging
    to:
      pod:
        name: backend
        namespace: production
    port: 8080
    protocol: tcp
    expect: fail

  - name: "DNS resolution works from backend"
    from:
      pod:
        name: backend
        namespace: production
    to:
      host: kube-dns.kube-system.svc.cluster.local
    port: 53
    protocol: udp
    expect: pass

  - name: "monitoring can scrape backend metrics"
    from:
      pod:
        name: prometheus-server
        namespace: monitoring
    to:
      pod:
        name: backend
        namespace: production
    port: 9090
    protocol: tcp
    expect: pass
```

Run the tests:

```bash
netassert run --file netassert-tests.yaml --kubeconfig ~/.kube/config

# With verbose output
netassert run --file netassert-tests.yaml --verbose --timeout 30s

# CI mode: exit code 1 on any failure
netassert run --file netassert-tests.yaml --fail-fast
```

## Inspektor Gadget for Network Tracing

Inspektor Gadget uses eBPF to trace actual network connections at the kernel level, providing ground truth about what traffic is occurring regardless of NetworkPolicy state.

### Installation

```bash
kubectl krew install gadget
kubectl gadget deploy
```

### Tracing Network Connections

```bash
# Trace all TCP connections from pods in the production namespace
kubectl gadget trace tcp \
  --namespace production \
  --timeout 60s \
  --output table

# Watch DNS queries from a specific pod
kubectl gadget trace dns \
  --namespace production \
  --podname backend-xxx \
  --timeout 30s

# Capture network events and filter for blocked connections
kubectl gadget trace network \
  --namespace production \
  --output json | \
  jq 'select(.verdict == "drop") | {src: .src, dst: .dst, port: .port}'
```

### Audit Mode: Discovering Policy Gaps

Use Inspektor Gadget to capture actual traffic patterns before writing policies:

```bash
# Run for 10 minutes to capture representative traffic
kubectl gadget trace network \
  --namespace production \
  --timeout 600s \
  --output json > /tmp/network-traffic.json

# Summarize unique connections
jq -r '[
  .src_namespace + "/" + .src_pod,
  .dst_namespace + "/" + .dst_pod,
  (.dst_port | tostring),
  .proto
] | @tsv' /tmp/network-traffic.json | sort -u | \
  column -t -s $'\t' -N "SOURCE,DESTINATION,PORT,PROTO"
```

### eBPF-Based Policy Verification with Cilium

If Cilium is the CNI, use Hubble for real-time connection auditing:

```bash
# Install Hubble CLI
HUBBLE_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/hubble/master/stable.txt)
curl -sL "https://github.com/cilium/hubble/releases/download/${HUBBLE_VERSION}/hubble-linux-amd64.tar.gz" | \
  sudo tar xz -C /usr/local/bin

# Enable Hubble relay
cilium hubble enable --ui

# Forward Hubble relay port
kubectl port-forward -n kube-system svc/hubble-relay 4245:443 &

# Observe dropped flows in the production namespace
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --follow

# Identify flows that should be allowed but are dropped
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --output json | \
  jq -r '
    .flow |
    select(.verdict == "DROPPED") |
    "\(.source.namespace)/\(.source.pod_name) -> \(.destination.namespace)/\(.destination.pod_name):\(.l4.TCP.destination_port // .l4.UDP.destination_port)"
  ' | sort | uniq -c | sort -rn
```

## Drawing Policy Graphs with Network Policy Advisor

### Generating DOT Graph Output

```bash
# Use network-policy-viewer to generate a Graphviz DOT file
kubectl get netpol --all-namespaces -o json | \
  python3 - <<'EOF'
import json, sys

data = json.load(sys.stdin)
policies = data['items']

print('digraph NetworkPolicies {')
print('  rankdir=LR;')
print('  node [shape=box];')

for pol in policies:
    ns = pol['metadata']['namespace']
    name = pol['metadata']['name']
    spec = pol.get('spec', {})

    pod_selector = spec.get('podSelector', {}).get('matchLabels', {})
    target = f"{ns}/{name}"

    # Ingress rules
    for ingress in spec.get('ingress', []):
        for src in ingress.get('from', []):
            src_ns = src.get('namespaceSelector', {}).get('matchLabels', {})
            src_pod = src.get('podSelector', {}).get('matchLabels', {})
            src_label = str(src_ns or src_pod or 'any')
            for port_spec in ingress.get('ports', [{}]):
                port = port_spec.get('port', 'any')
                print(f'  "{src_label}" -> "{target}" [label="{port}"];')

print('}')
EOF
```

Render with Graphviz:

```bash
kubectl get netpol --all-namespaces -o json | \
  python3 generate-dot.py > policies.dot

dot -Tsvg policies.dot -o policies.svg
dot -Tpng policies.dot -o policies.png
```

### Policy Matrix Generation

Generate a source-namespace x destination-namespace matrix:

```bash
#!/bin/bash
# policy-matrix.sh
# Shows which namespace pairs have explicit NetworkPolicies

NAMESPACES=(production staging monitoring shared-services databases)

echo -n "SRC\\DST\t"
printf '%s\t' "${NAMESPACES[@]}"
echo ""

for src in "${NAMESPACES[@]}"; do
  echo -n "${src}\t"
  for dst in "${NAMESPACES[@]}"; do
    # Count NetworkPolicies in dst namespace that reference src namespace
    COUNT=$(kubectl get netpol -n "${dst}" -o json 2>/dev/null | \
      jq --arg src "${src}" '
        [.items[] |
         .spec.ingress[]?.from[]?.namespaceSelector?.matchLabels? |
         select(. != null) |
         to_entries[] |
         select(.value == $src)] |
         length
      ')
    if [ "${COUNT}" -gt 0 ]; then
      echo -n "ALLOW(${COUNT})\t"
    else
      echo -n "-\t"
    fi
  done
  echo ""
done
```

## CI Integration for Policy Validation

### GitHub Actions Workflow

```yaml
# .github/workflows/network-policy-validation.yml
name: Network Policy Validation

on:
  pull_request:
    paths:
      - "k8s/namespaces/**/*-netpol.yaml"
      - "k8s/namespaces/**/networkpolicy*.yaml"

jobs:
  validate-policies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup kubectl
        uses: azure/setup-kubectl@v3
        with:
          version: "v1.29.0"

      - name: Create kind cluster
        uses: helm/kind-action@v1.8.0
        with:
          config: .github/kind-config.yaml

      - name: Install Calico CNI
        run: |
          kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/calico.yaml
          kubectl wait --timeout=120s --for=condition=Ready nodes --all

      - name: Apply test namespaces and pods
        run: |
          kubectl apply -f ci/test-namespaces.yaml
          kubectl apply -f ci/test-pods.yaml
          kubectl wait --timeout=60s \
            --for=condition=Ready pods \
            --all-namespaces \
            --selector=test-pod=true

      - name: Apply NetworkPolicies under test
        run: |
          kubectl apply -f k8s/namespaces/ -R

      - name: Run netassert validation
        run: |
          kubectl run netassert \
            --image=controlplane/netassert:v2.0.1 \
            --restart=Never \
            --command -- \
            netassert run \
              --file /tests/netassert-tests.yaml \
              --fail-fast
          kubectl cp netassert-tests.yaml netassert:/tests/netassert-tests.yaml
          kubectl wait --timeout=120s --for=condition=Completed pod/netassert

      - name: Run cyclonus simulation
        run: |
          kubectl cyclonus \
            --namespaces=production,staging,monitoring \
            --output-format=json > current-truth-table.json

          diff ci/baseline-truth-table.json current-truth-table.json || \
            (echo "Policy behavior changed — review the diff above" && exit 1)

      - name: Upload policy visualization
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: policy-graph
          path: policies.svg
```

### kind Configuration for Policy Testing

```yaml
# .github/kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
networking:
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"
```

### Test Namespace and Pod Fixtures

```yaml
# ci/test-namespaces.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    environment: production
    test-env: "true"
---
apiVersion: v1
kind: Namespace
metadata:
  name: staging
  labels:
    environment: staging
    test-env: "true"
---
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    purpose: monitoring
    test-env: "true"
```

```yaml
# ci/test-pods.yaml
apiVersion: v1
kind: Pod
metadata:
  name: frontend
  namespace: production
  labels:
    app: frontend
    tier: web
    test-pod: "true"
spec:
  containers:
    - name: netshoot
      image: nicolaka/netshoot:latest
      command: ["/bin/sh", "-c", "sleep 3600"]
---
apiVersion: v1
kind: Pod
metadata:
  name: backend
  namespace: production
  labels:
    app: backend
    tier: api
    test-pod: "true"
spec:
  containers:
    - name: netshoot
      image: nicolaka/netshoot:latest
      command: ["/bin/sh", "-c", "sleep 3600"]
---
apiVersion: v1
kind: Pod
metadata:
  name: postgres
  namespace: production
  labels:
    app: postgres
    tier: database
    test-pod: "true"
spec:
  containers:
    - name: postgres
      image: postgres:16-alpine
      env:
        - name: POSTGRES_PASSWORD
          value: testpass
```

## Cilium NetworkPolicy Editor

The Cilium Network Policy Editor (https://editor.networkpolicy.io) generates interactive visualizations. For programmatic use, the `cilium-cli` provides local policy analysis:

```bash
# Install Cilium CLI
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
curl -sL "https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-amd64.tar.gz" | \
  sudo tar xz -C /usr/local/bin

# Validate Cilium network policies
cilium policy validate --path k8s/namespaces/

# Check policy enforcement status
cilium policy get --output table

# Trace a specific flow (what policies would apply)
cilium policy trace \
  --src-k8s-pod production/frontend \
  --dst-k8s-pod production/backend \
  --dport 8080/tcp
```

### CiliumNetworkPolicy for L7 Enforcement

```yaml
# Cilium extends NetworkPolicy with L7 rules
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: backend-l7-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: backend
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: "GET"
                path: "/api/v1/.*"
              - method: "POST"
                path: "/api/v1/orders"
  egress:
    - toEndpoints:
        - matchLabels:
            app: postgres
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
    - toEntities:
        - kube-apiserver
    - toFQDNs:
        - matchPattern: "*.example.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

## Common Policy Mistakes and How to Detect Them

### Mistake 1: Missing DNS Egress Rule

```bash
# Test: from a pod with NetworkPolicy, can DNS be resolved?
kubectl exec -n production backend-xxx -- nslookup kubernetes.default.svc.cluster.local

# If this fails, add DNS egress rule:
cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
EOF
```

### Mistake 2: Overly Broad Namespace Selector

```bash
# Audit: find policies allowing traffic from all namespaces
kubectl get netpol --all-namespaces -o json | \
  jq -r '
    .items[] |
    . as $pol |
    .spec.ingress[]?.from[]? |
    select(.namespaceSelector == {}) |
    "\($pol.metadata.namespace)/\($pol.metadata.name): allows ingress from ALL namespaces"
  '
```

### Mistake 3: Policy Applying to Wrong Pods

```bash
# Check which pods a NetworkPolicy's podSelector matches
kubectl get pods -n production \
  -l "app=backend,tier=api" \
  -o wide

# Simulate the selector
kubectl get pods -n production \
  --selector="$(kubectl get netpol backend-policy -n production \
    -o jsonpath='{.spec.podSelector.matchLabels}' | \
    jq -r 'to_entries | map("\(.key)=\(.value)") | join(",")')"
```

## Policy Drift Detection

Detect when live cluster policies diverge from the git-tracked source of truth:

```bash
#!/bin/bash
# detect-policy-drift.sh

NAMESPACE=${1:-production}
GIT_POLICIES_DIR="k8s/namespaces/${NAMESPACE}"

echo "Checking for NetworkPolicy drift in namespace: ${NAMESPACE}"

# Get policies from cluster
CLUSTER_POLICIES=$(kubectl get netpol -n "${NAMESPACE}" \
  -o json | jq -r '.items[].metadata.name' | sort)

# Get policies from git
GIT_POLICIES=$(grep -rl 'kind: NetworkPolicy' "${GIT_POLICIES_DIR}" | \
  xargs grep -h 'name:' | awk '{print $2}' | sort -u)

# Compare
EXTRA_IN_CLUSTER=$(comm -23 \
  <(echo "${CLUSTER_POLICIES}") \
  <(echo "${GIT_POLICIES}"))

MISSING_FROM_CLUSTER=$(comm -13 \
  <(echo "${CLUSTER_POLICIES}") \
  <(echo "${GIT_POLICIES}"))

if [ -n "${EXTRA_IN_CLUSTER}" ]; then
  echo "ALERT: Policies in cluster but not in git (potential manual changes):"
  echo "${EXTRA_IN_CLUSTER}" | sed 's/^/  /'
fi

if [ -n "${MISSING_FROM_CLUSTER}" ]; then
  echo "ALERT: Policies in git but not in cluster (failed deployments?):"
  echo "${MISSING_FROM_CLUSTER}" | sed 's/^/  /'
fi

if [ -z "${EXTRA_IN_CLUSTER}" ] && [ -z "${MISSING_FROM_CLUSTER}" ]; then
  echo "No drift detected — cluster policies match git source of truth"
fi
```

## Default-Deny Baseline Policy

All namespaces should start from a default-deny posture. Add policies to permit required traffic rather than removing broad permits:

```yaml
# Apply to every application namespace
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Egress
---
# Allow DNS egress from all pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

### Allow Prometheus Scraping Pattern

A reusable pattern for permitting the monitoring namespace to scrape metrics from any application namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-prometheus-scrape
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app.kubernetes.io/name: prometheus
      ports:
        - protocol: TCP
          port: 9090
        - protocol: TCP
          port: 8080
```

## NetworkPolicy Generator Script

Automate first-draft policy generation from observed traffic patterns:

```bash
#!/bin/bash
# generate-policies-from-traffic.sh
# Generates NetworkPolicy stubs based on Inspektor Gadget captured flows

# Requires: network-traffic.json captured with:
# kubectl gadget trace network --namespace production --timeout 600s --output json > network-traffic.json

INPUT=${1:-network-traffic.json}
OUTPUT_DIR=${2:-generated-policies}
mkdir -p "${OUTPUT_DIR}"

# Extract unique source→destination+port tuples
jq -r '[
  .src_namespace,
  .src_pod,
  .dst_namespace,
  .dst_pod,
  (.dst_port | tostring),
  .proto
] | @tsv' "${INPUT}" | sort -u | while IFS=$'\t' read -r src_ns src_pod dst_ns dst_pod port proto; do
  POLICY_FILE="${OUTPUT_DIR}/allow-${src_ns}-to-${dst_ns}-${port}.yaml"

  cat >> "${POLICY_FILE}" <<EOF
# Auto-generated from traffic observation
# Review before applying to production
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-${src_ns}-ingress-${port}
  namespace: ${dst_ns}
spec:
  podSelector: {}  # TODO: narrow to specific pods
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ${src_ns}
      ports:
        - protocol: ${proto}
          port: ${port}
EOF

done

echo "Generated policy stubs in ${OUTPUT_DIR}/"
echo "Review and refine before applying with: kubectl apply -f ${OUTPUT_DIR}/"
```

## Testing NetworkPolicies with kube-bench

```bash
# kube-bench includes network policy checks in its CIS benchmark scan
kube-bench run --targets node,policies

# Check specifically for missing default-deny policies
kube-bench run --targets policies --check 5.3.1,5.3.2
```

Sample check output:

```
[WARN] 5.3.1 Ensure that the CNI in use supports NetworkPolicies (Manual)
[FAIL] 5.3.2 Ensure that all Namespaces have NetworkPolicies defined
      -- Namespaces without NetworkPolicies: default, kube-node-lease
```

## Summary

Automated NetworkPolicy testing requires a layered approach: cyclonus for simulating policy semantics without live traffic, netassert for validating actual connectivity between real pods, Inspektor Gadget for capturing ground-truth traffic patterns at the eBPF level, and CI integration to catch regressions before they reach production. The visualization tools (Graphviz policy graphs, policy matrices, Hubble UI) make complex policy interactions legible for security audits. Starting from a default-deny baseline and adding policies derived from observed traffic patterns produces minimal, auditable network segmentation that significantly reduces the blast radius of a compromised workload. Combined, these tools transform NetworkPolicy management from an error-prone manual practice into a continuously validated, auditable security control.
