---
title: "Kubernetes Network Troubleshooting: A Systematic Debugging Methodology"
date: 2027-08-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Troubleshooting", "Debugging"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Systematic methodology for diagnosing Kubernetes networking issues including pod-to-pod connectivity failures, DNS resolution problems, service endpoint debugging, CNI plugin troubleshooting, network policy blocking, and packet capture techniques."
more_link: "yes"
url: /kubernetes-network-debugging-systematic-guide/
---

Kubernetes networking failures surface in deceptively similar ways — connection refused, connection timed out, name resolution failure — regardless of whether the root cause is a misconfigured CNI plugin, a network policy blocking legitimate traffic, a stale Endpoints object, or a DNS misconfiguration. A systematic debugging methodology that isolates each layer prevents hours of chasing the wrong hypothesis.

<!--more-->

## The OSI Layered Approach to Kubernetes Networking

Kubernetes networking spans multiple abstraction layers. Debugging must proceed bottom-up:

```
Layer 7: Application (HTTP 502, connection reset)
Layer 6: DNS (NXDOMAIN, SERVFAIL, timeout)
Layer 5: Service/kube-proxy (ClusterIP, NodePort, Endpoints)
Layer 4: Network Policies (iptables/eBPF rule evaluation)
Layer 3: Pod network (CNI plugin, overlay, routes)
Layer 2: Node network (MTU, VXLAN, NIC configuration)
```

### Debugging Toolkit Setup

Deploy a persistent debug pod with comprehensive networking tools:

```yaml
# netdebug-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: netdebug
  namespace: default
spec:
  containers:
    - name: netdebug
      image: nicolaka/netshoot:latest
      command: ["sleep", "infinity"]
      securityContext:
        capabilities:
          add: ["NET_ADMIN", "NET_RAW"]
  hostNetwork: false
  tolerations:
    - operator: Exists
  restartPolicy: Never
```

```bash
kubectl apply -f netdebug-pod.yaml
kubectl exec -it netdebug -- bash
```

For node-level debugging, use a privileged DaemonSet or the node debug command:

```bash
# Ephemeral debug container on a running pod
kubectl debug -it <pod-name> --image=nicolaka/netshoot --target=<container-name>

# Node-level debugging (access host network namespace)
kubectl debug node/<node-name> -it --image=nicolaka/netshoot
```

## Layer 3: Pod-to-Pod Connectivity

### Validating Pod Network Reachability

```bash
# Get source and destination pod IPs
kubectl get pods -n production -o wide

SOURCE_POD="app-frontend-6d8f9b-xvz"
DEST_POD="app-backend-7c4d5e-abc"
DEST_IP=$(kubectl get pod $DEST_POD -n production -o jsonpath='{.status.podIP}')

# Ping from source pod to destination pod IP directly
kubectl exec -n production $SOURCE_POD -- ping -c 4 $DEST_IP

# Traceroute to identify where packets are dropped
kubectl exec -n production $SOURCE_POD -- traceroute $DEST_IP

# Test TCP connectivity on specific port
kubectl exec -n production $SOURCE_POD -- nc -zv $DEST_IP 8080
```

### CNI Plugin Diagnosis

Different CNI plugins have different failure modes:

**Flannel / VXLAN overlay issues:**

```bash
# On the node, check VTEP interface
ip link show flannel.1
ip -d link show flannel.1 | grep -E "vxlan|dstport|id"

# Check FDB (forwarding database) entries — should have one per remote node
bridge fdb show dev flannel.1

# Check that routes to pod CIDRs exist
ip route show | grep "via.*flannel"

# Check flannel logs
kubectl logs -n kube-flannel -l app=flannel --tail=100
```

**Calico troubleshooting:**

```bash
# Install calicoctl
curl -L https://github.com/projectcalico/calico/releases/download/v3.27.0/calicoctl-linux-amd64 -o calicoctl
chmod +x calicoctl && mv calicoctl /usr/local/bin/

# Check node status
calicoctl node status
calicoctl get nodes -o wide

# Check BGP peer status (if using BGP mode)
calicoctl node status | grep -A 20 "BGP summary"

# View IP pools
calicoctl get ippool -o wide

# Check felix logs on affected node
kubectl logs -n kube-system -l k8s-app=calico-node -c calico-node --tail=200 | grep -E "ERROR|WARN|drop"
```

**Cilium troubleshooting:**

```bash
# Check Cilium agent status
kubectl exec -n kube-system ds/cilium -- cilium status

# Check endpoint state for specific pod
POD_IP=$(kubectl get pod $SOURCE_POD -n production -o jsonpath='{.status.podIP}')
kubectl exec -n kube-system ds/cilium -- cilium endpoint list | grep $POD_IP

# Run Cilium connectivity test
kubectl exec -n kube-system ds/cilium -- cilium connectivity test

# Check policy verdicts
kubectl exec -n kube-system ds/cilium -- cilium monitor --type drop
kubectl exec -n kube-system ds/cilium -- cilium monitor --type policy-verdict
```

### MTU Mismatch Diagnosis

MTU mismatches cause intermittent failures where small packets succeed but large payloads fail:

```bash
# Discover path MTU from pod to destination
kubectl exec -n production $SOURCE_POD -- tracepath $DEST_IP

# Test specific packet sizes (look for fragmentation needed)
kubectl exec -n production $SOURCE_POD -- ping -c 4 -M do -s 1400 $DEST_IP
kubectl exec -n production $SOURCE_POD -- ping -c 4 -M do -s 1450 $DEST_IP
kubectl exec -n production $SOURCE_POD -- ping -c 4 -M do -s 1472 $DEST_IP

# Check interface MTU on node
ip link show eth0 | grep mtu
ip link show flannel.1 | grep mtu

# VXLAN overhead: 50 bytes — so node MTU 1500 means pod MTU should be 1450
```

For Calico/Flannel, MTU can be corrected via ConfigMap:

```bash
# Flannel MTU configuration
kubectl get cm kube-flannel-cfg -n kube-flannel -o yaml | grep -A 5 mtu

# Edit to set correct MTU
kubectl edit cm kube-flannel-cfg -n kube-flannel
```

## Layer 5: Service and Endpoint Debugging

### Service Endpoint Validation

```bash
# Verify service exists and has endpoints
kubectl get svc -n production
kubectl get endpoints -n production

SERVICE="api-backend"

# Check endpoint addresses — empty means no matching pods
kubectl get endpoints $SERVICE -n production -o yaml

# If endpoints are empty, check selector match
kubectl describe svc $SERVICE -n production | grep Selector
kubectl get pods -n production -l app=api-backend  # Should match selector

# Verify pod readiness — unready pods are excluded from endpoints
kubectl get pods -n production -l app=api-backend -o wide
kubectl describe pod -n production -l app=api-backend | grep -A 5 "Conditions:"
```

### ClusterIP Reachability

```bash
# Test ClusterIP directly
CLUSTER_IP=$(kubectl get svc api-backend -n production -o jsonpath='{.spec.clusterIP}')
PORT=$(kubectl get svc api-backend -n production -o jsonpath='{.spec.ports[0].port}')

kubectl exec -n production $SOURCE_POD -- nc -zv $CLUSTER_IP $PORT
kubectl exec -n production $SOURCE_POD -- curl -v http://$CLUSTER_IP:$PORT/health

# Bypass ClusterIP and test pod IP directly (isolates kube-proxy)
POD_IP=$(kubectl get pod api-backend-7c4d5e-abc -n production -o jsonpath='{.status.podIP}')
TARGET_PORT=$(kubectl get svc api-backend -n production -o jsonpath='{.spec.ports[0].targetPort}')
kubectl exec -n production $SOURCE_POD -- nc -zv $POD_IP $TARGET_PORT
```

### kube-proxy Diagnosis

```bash
# Check kube-proxy logs
kubectl logs -n kube-system -l k8s-app=kube-proxy --tail=100

# Verify iptables rules for the service (iptables mode)
NODE=$(kubectl get pod $SOURCE_POD -n production -o jsonpath='{.spec.nodeName}')
kubectl debug node/$NODE -it --image=nicolaka/netshoot -- bash

# Inside node debug container
nsenter -t 1 -n -- iptables-save | grep $CLUSTER_IP
nsenter -t 1 -n -- iptables -t nat -L KUBE-SERVICES | grep $SERVICE

# For IPVS mode
nsenter -t 1 -n -- ipvsadm -Ln | grep $CLUSTER_IP
```

If the Service ClusterIP has no iptables rules, kube-proxy may have failed or the service was created in a namespace kube-proxy does not watch.

### Headless Service and StatefulSet Debugging

```bash
# Headless service returns pod IPs directly via DNS
# A record: <pod-name>.<svc-name>.<namespace>.svc.cluster.local

kubectl exec -n production $SOURCE_POD -- nslookup \
  kafka-0.kafka-headless.kafka.svc.cluster.local

# Should return the pod IP, not a ClusterIP
```

## Layer 6: DNS Troubleshooting

### DNS Resolution Testing

```bash
# Basic DNS query from pod
kubectl exec -n production $SOURCE_POD -- nslookup kubernetes.default.svc.cluster.local
kubectl exec -n production $SOURCE_POD -- dig +short api-backend.production.svc.cluster.local
kubectl exec -n production $SOURCE_POD -- dig +short api-backend.production.svc.cluster.local @10.96.0.10

# Check /etc/resolv.conf inside pod
kubectl exec -n production $SOURCE_POD -- cat /etc/resolv.conf
# Expected: nameserver <kube-dns ClusterIP>, search production.svc.cluster.local svc.cluster.local cluster.local

# Check CoreDNS pod IP (should match nameserver in resolv.conf)
kubectl get svc kube-dns -n kube-system
```

### CoreDNS Diagnosis

```bash
# Check CoreDNS pod health
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=200

# Enable CoreDNS debug logging temporarily
kubectl edit cm coredns -n kube-system
# Add 'log' and 'debug' to Corefile
```

Example Corefile with debug logging:

```
# coredns-configmap-debug.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        log
        health {
           lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf {
           max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
```

```bash
# Apply updated ConfigMap and restart CoreDNS
kubectl apply -f coredns-configmap-debug.yaml
kubectl rollout restart deployment/coredns -n kube-system

# Tail CoreDNS logs while reproducing the issue
kubectl logs -n kube-system -l k8s-app=kube-dns -f

# Check CoreDNS metrics
kubectl exec -n kube-system -l k8s-app=kube-dns -- wget -qO- localhost:9153/metrics | grep coredns_dns
```

### NDOTS and Search Domain Issues

The default `ndots:5` in Kubernetes causes up to 5 failed queries before reaching the external DNS:

```bash
# Trace the full DNS query sequence for an external name
kubectl exec -n production $SOURCE_POD -- dig +trace external-service.example.com

# For "external-service.example.com", with ndots:5, Kubernetes tries:
# 1. external-service.example.com.production.svc.cluster.local (fails)
# 2. external-service.example.com.svc.cluster.local (fails)
# 3. external-service.example.com.cluster.local (fails)
# 4. external-service.example.com. (succeeds)

# Fix: Add a trailing dot to force absolute name
kubectl exec -n production $SOURCE_POD -- dig external-service.example.com.
```

Reduce NDOTS in Pod spec for external-heavy workloads:

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
```

## Layer 4: Network Policy Debugging

### Identifying Policy Blocking

Network policies silently drop traffic — pods neither receive connection refused nor timeout context. A dropped packet looks identical to a misconfigured backend.

```bash
# Check all NetworkPolicies in namespace
kubectl get networkpolicy -n production -o yaml

# Check ingress policies on destination pod
kubectl get networkpolicy -n production -o yaml | grep -A 20 "podSelector"

# Test connectivity with network policies active vs inactive
# Method: Apply a "allow-all" policy temporarily to isolate
```

```yaml
# allow-all-ingress-test.yaml — TESTING ONLY, remove immediately after
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-all-ingress-test
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-backend
  ingress:
    - {}
  policyTypes:
    - Ingress
```

```bash
kubectl apply -f allow-all-ingress-test.yaml
# Test connectivity
kubectl exec -n production $SOURCE_POD -- nc -zv $DEST_IP $TARGET_PORT
# If this succeeds, the original NetworkPolicy was blocking traffic
kubectl delete -f allow-all-ingress-test.yaml
```

### Cilium Network Policy Tracing

```bash
# Trace policy decisions for a specific flow (Cilium only)
kubectl exec -n kube-system ds/cilium -- cilium policy trace \
  --src-k8s-pod production/$SOURCE_POD \
  --dst-k8s-pod production/$DEST_POD \
  --dport 8080/tcp

# Monitor dropped packets in real-time
kubectl exec -n kube-system ds/cilium -- cilium monitor --type drop

# View Hubble flow for policy drops
kubectl exec -n kube-system ds/cilium -- hubble observe \
  --namespace production \
  --verdict DROPPED \
  --last 100
```

## Packet Capture with tcpdump and ngrep

### Capturing Traffic Inside a Container

```bash
# Run tcpdump in sidecar or debug container
kubectl debug -it $DEST_POD -n production \
  --image=nicolaka/netshoot \
  --target=api-backend \
  -- tcpdump -i any -nn -w /tmp/capture.pcap port 8080

# Copy capture file for analysis
kubectl cp production/$DEST_POD:/tmp/capture.pcap ./capture.pcap

# Analyze with tshark
tshark -r capture.pcap -Y "tcp.flags.reset==1" -T fields \
  -e ip.src -e ip.dst -e tcp.dstport
```

### ngrep for HTTP Traffic Inspection

```bash
# Inspect HTTP requests/responses without decrypting TLS
kubectl debug -it $DEST_POD -n production \
  --image=nicolaka/netshoot \
  --target=api-backend \
  -- ngrep -d any -q -W byline "HTTP" port 8080

# Filter for specific endpoints
kubectl debug -it $DEST_POD -n production \
  --image=nicolaka/netshoot \
  --target=api-backend \
  -- ngrep -d any -q "GET /api/health" port 8080
```

### Node-Level Packet Capture

```bash
# Capture on VXLAN interface to see all inter-node traffic
kubectl debug node/$NODE -it --image=nicolaka/netshoot -- bash
# Inside:
nsenter -t 1 -n -- tcpdump -i flannel.1 -nn \
  "host $DEST_IP" -w /tmp/vxlan-capture.pcap

# For Calico in BGP mode, capture on physical interface
nsenter -t 1 -n -- tcpdump -i eth0 -nn \
  "host $DEST_IP and port 8080" -w /tmp/node-capture.pcap
```

## Systematic Troubleshooting Decision Tree

```
Symptom: Pod A cannot reach Pod B on port 8080
│
├── Can A ping B pod IP directly?
│   ├── NO  → CNI issue (Layer 3)
│   │         Check: CNI plugin logs, routes, FDB, MTU
│   └── YES → Continue
│
├── Can A reach B pod IP on port 8080?
│   ├── NO  → Application or NetworkPolicy issue
│   │         Check: Is app listening? NetworkPolicy ingress rules?
│   └── YES → Continue
│
├── Can A reach Service ClusterIP?
│   ├── NO  → kube-proxy or Endpoints issue
│   │         Check: Endpoints populated? kube-proxy rules? IPTables?
│   └── YES → Continue
│
├── Can A resolve the Service DNS name?
│   ├── NO  → DNS issue
│   │         Check: CoreDNS pods, ConfigMap, ndots, resolv.conf
│   └── YES → Problem is intermittent or load-balanced
│             Check: Unhealthy endpoints, session affinity, HPA scaling
```

### Quick Triage Script

```bash
#!/usr/bin/env bash
# network-triage.sh
NAMESPACE="${1:-production}"
POD_A="${2:-frontend-pod-name}"
SVC="${3:-backend-service-name}"

echo "=== Pod Status ==="
kubectl get pods -n "$NAMESPACE" -o wide

echo "=== Service Endpoints ==="
kubectl get endpoints "$SVC" -n "$NAMESPACE" -o yaml | grep -A 5 "addresses:"

echo "=== DNS Resolution ==="
kubectl exec -n "$NAMESPACE" "$POD_A" -- nslookup "$SVC.$NAMESPACE.svc.cluster.local" 2>/dev/null

echo "=== Network Policies ==="
kubectl get networkpolicy -n "$NAMESPACE"

echo "=== CoreDNS Status ==="
kubectl get pods -n kube-system -l k8s-app=kube-dns

echo "=== CNI Plugin Status ==="
kubectl get pods -n kube-system -l k8s-app=calico-node 2>/dev/null || \
kubectl get pods -n kube-flannel -l app=flannel 2>/dev/null || \
kubectl get pods -n kube-system -l k8s-app=cilium 2>/dev/null

echo "=== Recent Network Events ==="
kubectl get events -n "$NAMESPACE" --sort-by='.lastTimestamp' | tail -20
```

The systematic layer-by-layer approach eliminates ambiguity. Confirming pod-IP reachability before testing ClusterIP, and testing ClusterIP before testing DNS names, narrows the failure domain to a single networking component with each step. Combined with packet capture, this methodology resolves the majority of Kubernetes network issues without requiring cluster-level access or CNI plugin expertise.
