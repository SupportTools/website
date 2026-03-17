---
title: "Kubernetes Network Policy Enforcement: Testing, Visualization, and Audit Tooling"
date: 2030-10-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Network Policy", "Security", "Hubble", "Calico", "Cilium", "Zero Trust"]
categories:
- Kubernetes
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise network policy guide covering network policy testing with netassert and cyclonus, Hubble for policy visualization, Calico network policy auditing, policy-as-code workflows, and building network policy testing into CI/CD pipelines."
more_link: "yes"
url: "/kubernetes-network-policy-enforcement-testing-visualization-audit-tooling/"
---

Writing Kubernetes NetworkPolicy YAML is easy. Knowing whether those policies actually enforce the intended access control is hard. A policy with a misplaced `podSelector: {}` allows all pods in a namespace. A missing egress rule silently blocks DNS, breaking every pod in the namespace. Without systematic testing and visualization, network policies become security theater — YAML that looks secure but behaves unexpectedly under the actual workload topology.

This guide covers the operational toolchain for network policy enforcement: automated testing with netassert and cyclonus, real-time flow visualization with Hubble, audit workflows with Calico, and integrating policy testing into CI/CD pipelines so network access regressions are caught before they reach production.

<!--more-->

## Network Policy Fundamentals Review

Before testing, the semantics must be precise:

```yaml
# Default deny all ingress to a namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: production
spec:
  podSelector: {}  # Selects ALL pods in namespace
  policyTypes:
    - Ingress
  # No ingress rules = deny all ingress
```

```yaml
# Default deny all egress from a namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Egress
  # No egress rules = deny all egress (including DNS!)
```

```yaml
# Allow DNS egress before adding default-deny-egress
# Must be applied BEFORE the deny rule to avoid breaking resolution
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
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
```

### Critical Rules That Are Easily Missed

```yaml
# Pods with network policies get NO default access to the Kubernetes API
# Add explicitly if pods need API access:
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-kubernetes-api
  namespace: production
spec:
  podSelector:
    matchLabels:
      needs-api-access: "true"
  policyTypes:
    - Egress
  egress:
    - ports:
        - port: 443
          protocol: TCP
        - port: 6443
          protocol: TCP
      to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 192.168.0.0/16
              - 172.16.0.0/12
```

## netassert: Declarative Network Policy Testing

netassert provides a declarative YAML format for specifying expected network connectivity and runs tests by deploying test containers that probe the connections.

### Installation

```bash
# Install netassert CLI
curl -sSL https://github.com/controlplaneio/netassert/releases/latest/download/netassert-linux-amd64 \
  -o /usr/local/bin/netassert
chmod +x /usr/local/bin/netassert

# Verify
netassert version
```

### Writing Network Policy Tests

```yaml
# network-policy-tests.yaml

# Test ingress policies for the production namespace
k8s:
  deployments:
    # Test: frontend can reach backend on port 8080
    - name: production:frontend
      to:
        - name: production:backend
          port: 8080
          protocol: tcp
          allowed: true

    # Test: frontend CANNOT reach database
    - name: production:frontend
      to:
        - name: production:postgres
          port: 5432
          protocol: tcp
          allowed: false

    # Test: backend can reach database
    - name: production:backend
      to:
        - name: production:postgres
          port: 5432
          protocol: tcp
          allowed: true

    # Test: external pod (different namespace) CANNOT reach production services
    - name: staging:test-pod
      to:
        - name: production:backend
          port: 8080
          protocol: tcp
          allowed: false

    # Test: monitoring namespace can reach metrics endpoints
    - name: monitoring:prometheus
      to:
        - name: production:backend
          port: 9090
          protocol: tcp
          allowed: true

    # Test: DNS egress works from all pods
    - name: production:frontend
      to:
        - host: kube-dns.kube-system.svc.cluster.local
          port: 53
          protocol: udp
          allowed: true

    # Test: external HTTPS egress is allowed for specific services
    - name: production:payment-service
      to:
        - host: api.payment-provider.com
          port: 443
          protocol: tcp
          allowed: true

    # Test: most pods CANNOT make arbitrary external connections
    - name: production:backend
      to:
        - host: external-site.example.com
          port: 443
          protocol: tcp
          allowed: false
```

```bash
# Run tests against the cluster
netassert test network-policy-tests.yaml

# Expected output:
# PASS: production:frontend -> production:backend:8080 (tcp, allowed=true)
# PASS: production:frontend -> production:postgres:5432 (tcp, allowed=false)
# PASS: production:backend -> production:postgres:5432 (tcp, allowed=true)
# PASS: staging:test-pod -> production:backend:8080 (tcp, allowed=false)
# PASS: monitoring:prometheus -> production:backend:9090 (tcp, allowed=true)
# ...
#
# Results: 12 passed, 0 failed

# Run with verbose output to see actual connection attempts
netassert test -v network-policy-tests.yaml

# Generate JUnit XML for CI integration
netassert test --output junit -o results.xml network-policy-tests.yaml
```

## cyclonus: Network Policy Conformance Testing

cyclonus is a network policy conformance test suite that systematically verifies a CNI plugin's implementation against the Kubernetes network policy spec. It generates all policy combinations and tests them exhaustively.

### Installation and Usage

```bash
# Install cyclonus
kubectl apply -f https://raw.githubusercontent.com/mattfenwick/cyclonus/main/hack/cyclonus-job.yaml

# Or run as a job:
cat << 'EOF' | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: cyclonus
  namespace: cyclonus
spec:
  template:
    spec:
      serviceAccountName: cyclonus
      restartPolicy: Never
      containers:
        - name: cyclonus
          image: mfenwick100/cyclonus:latest
          args:
            - probe
            - --mode=all-available
            - --cleanup-after=false
            - --perturbation-wait-seconds=3
            # Test only specific namespaces
            - --namespace-labels=cyclonus-test
            # Generate markdown report
            - --report-format=markdown
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
EOF

# Watch progress
kubectl logs -f job/cyclonus -n cyclonus

# Get results
kubectl logs job/cyclonus -n cyclonus > cyclonus-results.txt
grep -E "PASS|FAIL" cyclonus-results.txt | tail -50
```

### Understanding cyclonus Output

cyclonus tests every combination of:
- Empty policy vs. policies selecting pods/namespaces
- Ingress vs. egress rules
- Port-specific rules vs. protocol-specific rules
- Combined selectors

```
# Example cyclonus output (abbreviated):
# Policy: allow-ingress-from-namespace
# Case 1: source=namespace-a, dest=namespace-b (namespace-a matches selector)
#   Expected: ALLOWED
#   Actual:   ALLOWED
#   Result:   PASS
#
# Case 2: source=namespace-c, dest=namespace-b (namespace-c does NOT match)
#   Expected: BLOCKED
#   Actual:   BLOCKED
#   Result:   PASS
#
# FAIL (6): Policy with podSelector and namespaceSelector combined
#   Expected: ALLOWED (both selectors must match)
#   Actual:   BLOCKED
#   Note: CNI may not correctly implement AND semantics for combined selectors
```

## Hubble: Real-Time Network Policy Flow Visualization

Hubble is built on Cilium eBPF and provides network flow visibility. It shows which connections succeed and which are dropped by policies — essential for debugging policy behavior.

### Installing Hubble with Cilium

```bash
# Cilium must be the CNI for Hubble to work
# Install Cilium with Hubble enabled
helm install cilium cilium/cilium \
  --namespace kube-system \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true \
  --set hubble.metrics.enabled="{dns,drop,tcp,flow,icmp,http}" \
  --version 1.16.3

# Install Hubble CLI
curl -L --fail --remote-name-all \
  https://github.com/cilium/hubble/releases/latest/download/hubble-linux-amd64.tar.gz
tar xzvf hubble-linux-amd64.tar.gz
sudo mv hubble /usr/local/bin/

# Set up port-forward to Hubble relay
cilium hubble port-forward &

# Verify Hubble status
hubble status
hubble observe --last 20
```

### Observing Network Policy Drops

```bash
# Watch all dropped connections in real-time
hubble observe --verdict DROPPED --follow

# Example output:
# Sep 25 10:23:45.123  DROPPED  production/frontend → production/postgres:5432/TCP
#   Reason: Policy denied
#   Direction: EGRESS
#   Identity: namespace=production,app=frontend
#   Source: 10.1.2.3:54321
#   Destination: 10.1.2.10:5432

# Watch drops for specific namespace
hubble observe \
  --namespace production \
  --verdict DROPPED \
  --follow

# Watch traffic to a specific pod
hubble observe \
  --to-pod production/postgres-0 \
  --follow

# Watch traffic from a specific service
hubble observe \
  --from-service production/payment-service \
  --follow

# Show drops grouped by policy
hubble observe \
  --verdict DROPPED \
  --output json | \
  jq -r '.source.namespace + "/" + .source.pod_name + " -> " + .destination.namespace + "/" + .destination.pod_name + ":" + (.destination.port | tostring)' | \
  sort | uniq -c | sort -rn | head -20

# Filter for a specific port
hubble observe \
  --protocol tcp \
  --port 5432 \
  --verdict DROPPED \
  --output json | \
  jq '{
    time: .time,
    source: .source.pod_name,
    dest: .destination.pod_name,
    verdict: .verdict,
    drop_reason: .drop_reason_desc
  }'
```

### Hubble UI for Policy Visualization

```bash
# Access Hubble UI
cilium hubble ui &
# Opens browser at http://localhost:12000

# Or expose via port-forward
kubectl port-forward -n kube-system svc/hubble-ui 12000:80 &
```

The Hubble UI service map shows:
- All pod-to-pod communication flows
- Color-coded by verdict (allowed/dropped/forwarded)
- Policy names responsible for decisions
- Flow volume over time

### Hubble Metrics for Policy Monitoring

```bash
# Hubble exports Prometheus metrics for flow counts
# Key metrics:
# hubble_drop_total{direction,reason,protocol} - Dropped flows
# hubble_flows_processed_total{verdict,protocol,direction} - All flows
# hubble_policy_verdict_total{direction,match,namespace} - Policy verdicts

# Dashboard query: policy drop rate by namespace
sum(rate(hubble_drop_total[5m])) by (namespace, reason)

# Dashboard query: allowed vs denied ratio
sum(rate(hubble_flows_processed_total{verdict="DROPPED"}[5m])) /
sum(rate(hubble_flows_processed_total[5m]))
```

## Calico Network Policy Auditing

Calico extends Kubernetes NetworkPolicy with GlobalNetworkPolicy and NetworkPolicy resources that support richer matching criteria. It also provides audit-friendly tooling.

### Calico Policy Tiers

```yaml
# Define policy tiers for layered enforcement
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: security
spec:
  order: 100  # Lower order = evaluated first
---
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: platform
spec:
  order: 200
---
apiVersion: projectcalico.org/v3
kind: Tier
metadata:
  name: application
spec:
  order: 300
```

```yaml
# Global network policy in security tier
# Applied to all workloads cluster-wide
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: security.block-lateral-movement
spec:
  tier: security
  order: 100
  selector: all()
  types:
    - Ingress
    - Egress
  ingress:
    - action: Allow
      source:
        selector: trusted == "true"
    - action: Deny
      source:
        selector: all()
        # Deny cross-namespace traffic not explicitly allowed
        notNamespaceSelector: kubernetes.io/metadata.name == namespace
  egress:
    - action: Allow
      destination:
        selector: trusted == "true"
    - action: Pass  # Pass to application tier for other traffic
```

### calicoctl Policy Analysis

```bash
# Install calicoctl
curl -L https://github.com/projectcalico/calico/releases/latest/download/calicoctl-linux-amd64 \
  -o /usr/local/bin/calicoctl
chmod +x /usr/local/bin/calicoctl

# List all network policies across all namespaces
calicoctl get networkpolicy --all-namespaces -o wide

# List global network policies
calicoctl get globalnetworkpolicy -o wide

# Analyze which policies apply to a specific pod
ENDPOINT_IP=$(kubectl get pod my-pod -n production -o jsonpath='{.status.podIP}')
calicoctl get workloadendpoint \
  --namespace production \
  -o json | \
  jq --arg ip "$ENDPOINT_IP" \
  '.items[] | select(.spec.ipNetworks[] | contains($ip))'

# Describe a specific endpoint's active policies
calicoctl describe workloadendpoint \
  production/node1-k8s-my-pod--abcdef-eth0

# Check for policy conflicts or overlaps
calicoctl get networkpolicy --all-namespaces -o yaml | \
  python3 -c "
import sys, yaml
policies = list(yaml.safe_load_all(sys.stdin))
for p in policies:
    if p and p.get('kind') == 'NetworkPolicy':
        print(f'{p[\"metadata\"][\"namespace\"]}/{p[\"metadata\"][\"name\"]}')
        spec = p.get('spec', {})
        print(f'  podSelector: {spec.get(\"podSelector\", {})}')
        print(f'  ingress rules: {len(spec.get(\"ingress\", []))}')
        print(f'  egress rules: {len(spec.get(\"egress\", []))}')
"
```

### Calico Flow Logs

```yaml
# Enable Calico flow logs
apiVersion: projectcalico.org/v3
kind: FelixConfiguration
metadata:
  name: default
spec:
  flowLogsEnabled: true
  flowLogsFlushInterval: 15s
  flowLogsFilePerNodeLimit: 10000
  flowLogsStagedPolicies: true  # Log policy decisions as staged (pre-enforcement)
  # Aggregation settings
  flowLogsAggregationKindForAllowed: 2  # Aggregate by source/dest
  flowLogsAggregationKindForDenied: 1   # Detailed denied flow logs
```

```bash
# Query Calico flow logs from ElasticSearch/Loki
# (Assuming Calico Enterprise with EE logging)
curl -X GET "http://elasticsearch:9200/calico-flow-logs-*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "bool": {
        "must": [
          {"term": {"action": "deny"}},
          {"term": {"dest_namespace": "production"}},
          {"range": {"@timestamp": {"gte": "now-1h"}}}
        ]
      }
    },
    "aggs": {
      "by_source": {
        "terms": {"field": "source_namespace"},
        "aggs": {
          "by_dest_port": {
            "terms": {"field": "dest_port"}
          }
        }
      }
    }
  }' | jq '.aggregations.by_source.buckets[] | {namespace: .key, ports: [.by_dest_port.buckets[].key]}'
```

## Policy-as-Code Workflow

### Conftest for Policy Validation

Conftest uses Open Policy Agent (OPA) to validate Kubernetes manifests against policy rules:

```rego
# policy/network-policy.rego
package kubernetes.admission

# Require default-deny-ingress policy in production namespaces
deny[msg] {
    input.request.kind.kind == "Namespace"
    input.request.object.metadata.labels["environment"] == "production"
    not namespace_has_default_deny(input.request.object.metadata.name)
    msg := sprintf("Namespace %v lacks default-deny-ingress network policy", [input.request.object.metadata.name])
}

# Validate NetworkPolicy selectors are not overly permissive
warn[msg] {
    input.request.kind.kind == "NetworkPolicy"
    rule := input.request.object.spec.ingress[_]
    peer := rule.from[_]
    # Empty namespaceSelector matches ALL namespaces
    peer.namespaceSelector == {}
    not peer.podSelector
    msg := sprintf("NetworkPolicy %v/%v has overly permissive ingress: empty namespaceSelector without podSelector matches all pods in all namespaces",
                   [input.request.object.metadata.namespace, input.request.object.metadata.name])
}

# Require egress DNS allowance before default deny
deny[msg] {
    input.request.kind.kind == "NetworkPolicy"
    input.request.object.spec.podSelector == {}
    count(input.request.object.spec.egress) == 0
    "Egress" == input.request.object.spec.policyTypes[_]
    msg := "Default deny egress policy must include DNS allowance (port 53)"
}
```

```bash
# Test policies against manifests
conftest test \
  --policy policy/ \
  kubernetes/production/network-policies/ \
  kubernetes/production/namespaces/

# Test all manifests in a directory
find kubernetes/ -name "*.yaml" | xargs conftest test --policy policy/
```

### Validating NetworkPolicy Syntax with kyverno

```yaml
# kyverno-policy-rules.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-network-policy-labels
spec:
  validationFailureAction: audit  # audit=warn, enforce=block
  rules:
    - name: require-owner-label
      match:
        any:
          - resources:
              kinds:
                - NetworkPolicy
      validate:
        message: "NetworkPolicy must have an 'owner' label"
        pattern:
          metadata:
            labels:
              owner: "?*"

    - name: no-allow-all-ingress
      match:
        any:
          - resources:
              kinds:
                - NetworkPolicy
      validate:
        message: "NetworkPolicy must not allow all ingress (empty from selector with empty podSelector)"
        deny:
          conditions:
            all:
              - key: "{{ request.object.spec.ingress[].from[] | length(@) }}"
                operator: Equals
                value: "0"
              - key: "{{ request.object.spec.ingress | length(@) }}"
                operator: GreaterThan
                value: "0"
              - key: "{{ request.object.spec.podSelector }}"
                operator: Equals
                value: {}
```

## CI/CD Integration

### GitHub Actions Network Policy Test Pipeline

```yaml
# .github/workflows/network-policy-test.yml
name: Network Policy Tests

on:
  push:
    paths:
      - 'kubernetes/network-policies/**'
      - 'kubernetes/namespaces/**'
  pull_request:
    paths:
      - 'kubernetes/network-policies/**'
      - 'kubernetes/namespaces/**'

jobs:
  validate-policies:
    name: Validate Network Policies
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install tools
        run: |
          # Install kubectl
          curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
          chmod +x kubectl && sudo mv kubectl /usr/local/bin/

          # Install conftest
          curl -L https://github.com/open-policy-agent/conftest/releases/latest/download/conftest_Linux_x86_64.tar.gz | tar xz
          sudo mv conftest /usr/local/bin/

          # Install netassert
          curl -sSL https://github.com/controlplaneio/netassert/releases/latest/download/netassert-linux-amd64 \
            -o /usr/local/bin/netassert
          chmod +x /usr/local/bin/netassert

      - name: Lint network policies
        run: |
          conftest test \
            --policy policy/ \
            kubernetes/network-policies/ \
            --output github

      - name: Validate YAML syntax
        run: |
          find kubernetes/network-policies/ -name "*.yaml" | while read f; do
            kubectl apply --dry-run=client -f "$f" 2>&1 || {
              echo "::error file=$f::Invalid NetworkPolicy YAML"
              exit 1
            }
          done

      - name: Check for missing default-deny
        run: |
          python3 scripts/check-namespace-policies.py \
            kubernetes/namespaces/ \
            kubernetes/network-policies/

  integration-tests:
    name: Integration Tests (kind cluster)
    runs-on: ubuntu-latest
    needs: validate-policies
    steps:
      - uses: actions/checkout@v4

      - name: Create kind cluster with Cilium
        run: |
          # Create kind cluster
          cat << 'EOF' > kind-config.yaml
          kind: Cluster
          apiVersion: kind.x-k8s.io/v1alpha4
          nodes:
            - role: control-plane
            - role: worker
            - role: worker
          networking:
            disableDefaultCNI: true  # We'll install Cilium
          EOF

          kind create cluster --config kind-config.yaml

          # Install Cilium (CNI that supports NetworkPolicy)
          helm install cilium cilium/cilium \
            --namespace kube-system \
            --set ipam.mode=kubernetes \
            --set hubble.relay.enabled=true \
            --set kubeProxyReplacement=partial \
            --wait

      - name: Deploy test workloads
        run: |
          kubectl apply -f tests/fixtures/namespaces.yaml
          kubectl apply -f tests/fixtures/deployments.yaml
          kubectl wait --for=condition=available deployment --all --all-namespaces --timeout=120s

      - name: Apply network policies
        run: |
          kubectl apply -f kubernetes/network-policies/
          # Wait for policies to propagate
          sleep 5

      - name: Run netassert tests
        run: |
          netassert test \
            --output junit \
            -o test-results/netassert-results.xml \
            tests/network-policy-tests.yaml

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: network-policy-test-results
          path: test-results/

      - name: Publish test results
        uses: EnricoMi/publish-unit-test-result-action@v2
        if: always()
        with:
          files: "test-results/**/*.xml"

      - name: Capture Hubble drops (if tests failed)
        if: failure()
        run: |
          cilium hubble port-forward &
          sleep 3
          hubble observe --verdict DROPPED --last 100 --output json > test-results/hubble-drops.json
          jq '.' test-results/hubble-drops.json

      - name: Cleanup
        if: always()
        run: kind delete cluster
```

## Generating Network Policies with Hubble

Hubble can observe current traffic and suggest network policies that would allow that traffic — useful when retrofitting policies onto an existing workload:

```bash
# Observe traffic for 10 minutes and generate policies
hubble observe \
  --namespace production \
  --verdict FORWARDED \
  --output json \
  --last 10000 | \
  python3 scripts/generate-policies.py > generated-policies.yaml

# Review generated policies before applying
kubectl apply --dry-run=client -f generated-policies.yaml

# Example generator script concept:
cat << 'PYEOF' > scripts/generate-policies.py
#!/usr/bin/env python3
import json
import sys
from collections import defaultdict

flows = [json.loads(line) for line in sys.stdin if line.strip()]

# Group by destination pod/port
connections = defaultdict(set)
for flow in flows:
    if flow.get('verdict') == 'FORWARDED':
        src_ns = flow.get('source', {}).get('namespace', '')
        src_app = flow.get('source', {}).get('labels', {}).get('app', '')
        dst_ns = flow.get('destination', {}).get('namespace', '')
        dst_app = flow.get('destination', {}).get('labels', {}).get('app', '')
        dst_port = flow.get('destination', {}).get('port', 0)
        proto = flow.get('l4', {}).get('TCP', {}) and 'TCP' or 'UDP'

        if all([src_ns, dst_ns, dst_app, dst_port]):
            connections[(dst_ns, dst_app, dst_port, proto)].add((src_ns, src_app))

for (dst_ns, dst_app, port, proto), sources in connections.items():
    print(f"---")
    print(f"# NetworkPolicy for {dst_ns}/{dst_app} port {port}/{proto}")
    print(f"apiVersion: networking.k8s.io/v1")
    print(f"kind: NetworkPolicy")
    print(f"metadata:")
    print(f"  name: allow-to-{dst_app}-port-{port}")
    print(f"  namespace: {dst_ns}")
    print(f"spec:")
    print(f"  podSelector:")
    print(f"    matchLabels:")
    print(f"      app: {dst_app}")
    print(f"  policyTypes:")
    print(f"    - Ingress")
    print(f"  ingress:")
    for src_ns, src_app in sorted(sources):
        print(f"    - from:")
        print(f"        - namespaceSelector:")
        print(f"            matchLabels:")
        print(f"              kubernetes.io/metadata.name: {src_ns}")
        if src_app:
            print(f"          podSelector:")
            print(f"            matchLabels:")
            print(f"              app: {src_app}")
        print(f"      ports:")
        print(f"        - port: {port}")
        print(f"          protocol: {proto}")
PYEOF
chmod +x scripts/generate-policies.py
```

## Network Policy Audit Report

Generate periodic audit reports showing the policy coverage and identified gaps:

```bash
#!/bin/bash
# network-policy-audit.sh

echo "=== Network Policy Audit Report ==="
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Namespaces without any network policy
echo "## Namespaces without NetworkPolicies"
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    count=$(kubectl get networkpolicy -n $ns --no-headers 2>/dev/null | wc -l)
    if [ "$count" -eq 0 ]; then
        labels=$(kubectl get namespace $ns -o jsonpath='{.metadata.labels}')
        echo "  - $ns (labels: $labels)"
    fi
done

echo ""
echo "## Namespaces without Default-Deny Ingress"
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    has_deny=$(kubectl get networkpolicy -n $ns -o json 2>/dev/null | \
        jq '[.items[] | select(.spec.podSelector == {} and (.spec.policyTypes[] | contains("Ingress")) and (.spec.ingress == null or .spec.ingress == []))] | length')
    if [ "${has_deny:-0}" -eq 0 ]; then
        echo "  - $ns"
    fi
done

echo ""
echo "## NetworkPolicies with Overly Broad Selectors"
kubectl get networkpolicy --all-namespaces -o json | \
    jq -r '.items[] |
    select(
        (.spec.ingress[].from[].namespaceSelector == {}) or
        (.spec.egress[].to[].namespaceSelector == {})
    ) |
    .metadata.namespace + "/" + .metadata.name + ": has empty namespaceSelector (matches ALL namespaces)"'

echo ""
echo "## Policy Coverage Summary"
TOTAL_NS=$(kubectl get namespaces --no-headers | wc -l)
NS_WITH_POLICIES=$(kubectl get networkpolicy --all-namespaces --no-headers 2>/dev/null | awk '{print $1}' | sort -u | wc -l)
echo "  Total namespaces: $TOTAL_NS"
echo "  Namespaces with policies: $NS_WITH_POLICIES"
echo "  Coverage: $(echo "scale=1; $NS_WITH_POLICIES * 100 / $TOTAL_NS" | bc)%"

echo ""
echo "## Total NetworkPolicies by Namespace"
kubectl get networkpolicy --all-namespaces --no-headers 2>/dev/null | \
    awk '{print $1}' | sort | uniq -c | sort -rn | head -20
```

Network policy enforcement is only as strong as the testing behind it. Automated tools like netassert and cyclonus convert policy intent into verifiable assertions that run on every change. Hubble makes policy behavior observable in production, turning "why is this connection failing?" from a guessing game into a log query. The combination of declarative testing, continuous visualization, and audit reporting transforms network policy from a one-time configuration activity into an ongoing operational discipline.
