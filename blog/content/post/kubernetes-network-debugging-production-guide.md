---
title: "Kubernetes Network Troubleshooting: Systematic Debugging for Production"
date: 2027-11-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Troubleshooting", "CNI", "DNS"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A systematic methodology for debugging Kubernetes network issues in production, covering CNI plugin failures, DNS resolution problems, kube-proxy modes, NetworkPolicy testing, MTU issues, and ephemeral debug containers."
more_link: "yes"
url: /kubernetes-network-debugging-production-guide/
---

Network issues in Kubernetes are among the hardest production problems to diagnose. The abstraction layers—CNI plugins, kube-proxy, iptables or IPVS rules, overlay networks, DNS resolution—create an environment where a single misconfiguration can cause intermittent failures that appear unrelated to networking. This guide presents a systematic methodology for isolating and resolving network problems in production Kubernetes clusters.

<!--more-->

# Kubernetes Network Troubleshooting: Systematic Debugging for Production

## The Kubernetes Networking Model

Before debugging, understand what Kubernetes guarantees about networking:

1. Every pod gets a unique IP address across the cluster
2. Pods on any node can communicate with all pods on any other node without NAT
3. Agents on a node (kubelet, kube-proxy) can communicate with all pods on that node
4. Pods see their own IP the same way external entities see it

When something breaks, the failure is in one of these layers:
- Physical or virtual network connectivity between nodes
- CNI plugin configuration or state
- kube-proxy rules (iptables or IPVS)
- DNS resolution via CoreDNS
- NetworkPolicy enforcement
- Service endpoints and load balancing

## Section 1: Diagnostic Methodology

Approach network debugging systematically. Jumping straight to packet captures wastes time. Start with layer-by-layer elimination.

### The Debugging Ladder

Work through these layers in order:

```
Layer 7 (Application)
    Layer 4 (TCP/UDP connectivity)
        Layer 3 (IP routing, pod CIDR)
            Layer 2 (ARP, overlay encapsulation)
                Layer 1 (Physical/virtual NIC, node connectivity)
```

Start from layer 1 upward for infrastructure failures. Start from layer 7 downward for service-specific failures.

### Verify Node Connectivity First

Before investigating pod networking, verify the nodes themselves can communicate:

```bash
# Check all nodes are Ready
kubectl get nodes -o wide

# Verify node-to-node connectivity from a privileged pod
kubectl run nettest --image=nicolaka/netshoot --rm -it --restart=Never \
  --overrides='{"spec":{"hostNetwork":true,"nodeName":"worker-node-02"}}' \
  -- ping -c 4 192.168.10.11

# Check for packet loss between nodes using mtr
kubectl run nettest --image=nicolaka/netshoot --rm -it --restart=Never \
  --overrides='{"spec":{"hostNetwork":true,"nodeName":"worker-node-01"}}' \
  -- mtr --report --report-cycles 20 192.168.10.12
```

### Pod-to-Pod Connectivity Matrix

Test pod connectivity systematically across nodes:

```bash
# Deploy test pods on specific nodes
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: nettest-node1
  labels:
    app: nettest
spec:
  nodeName: worker-node-01
  containers:
  - name: netshoot
    image: nicolaka/netshoot
    command: ["sleep", "3600"]
---
apiVersion: v1
kind: Pod
metadata:
  name: nettest-node2
  labels:
    app: nettest
spec:
  nodeName: worker-node-02
  containers:
  - name: netshoot
    image: nicolaka/netshoot
    command: ["sleep", "3600"]
EOF

# Wait for pods to be running
kubectl wait pod/nettest-node1 pod/nettest-node2 --for=condition=Ready --timeout=60s

# Get pod IPs
NODE1_POD_IP=$(kubectl get pod nettest-node1 -o jsonpath='{.status.podIP}')
NODE2_POD_IP=$(kubectl get pod nettest-node2 -o jsonpath='{.status.podIP}')

echo "Node1 pod IP: $NODE1_POD_IP"
echo "Node2 pod IP: $NODE2_POD_IP"

# Test cross-node pod connectivity
kubectl exec nettest-node1 -- ping -c 4 "$NODE2_POD_IP"
kubectl exec nettest-node2 -- ping -c 4 "$NODE1_POD_IP"

# Test TCP connectivity on a specific port
kubectl exec nettest-node1 -- nc -zv "$NODE2_POD_IP" 8080
```

## Section 2: CNI Plugin Debugging

The CNI plugin is responsible for assigning pod IPs and configuring network interfaces. CNI failures manifest as pods stuck in ContainerCreating state or pods that cannot communicate despite having IPs.

### Identifying CNI Failures

```bash
# Check CNI plugin pods
kubectl get pods -n kube-system | grep -E 'calico|cilium|flannel|weave|canal'

# Check CNI plugin logs
kubectl logs -n kube-system -l k8s-app=calico-node --tail=50

# Check kubelet logs for CNI errors
journalctl -u kubelet --since="10 minutes ago" | grep -i cni

# Common CNI error patterns in kubelet logs
journalctl -u kubelet | grep -E 'failed to.*network|CNI.*failed|plugin.*error'

# Check for pod events on a stuck pod
kubectl describe pod stuck-pod-name | grep -A 20 Events
```

### Inspect CNI Configuration

```bash
# CNI config is stored in /etc/cni/net.d/ on each node
# Access via a privileged pod with the host filesystem mounted
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: cni-debug
spec:
  nodeName: worker-node-01
  hostNetwork: true
  hostPID: true
  containers:
  - name: debug
    image: nicolaka/netshoot
    command: ["sleep", "3600"]
    securityContext:
      privileged: true
    volumeMounts:
    - name: cni-conf
      mountPath: /host/etc/cni
    - name: cni-bin
      mountPath: /host/opt/cni
  volumes:
  - name: cni-conf
    hostPath:
      path: /etc/cni
  - name: cni-bin
    hostPath:
      path: /opt/cni
EOF

# Inspect the CNI configuration
kubectl exec cni-debug -- cat /host/etc/cni/net.d/10-calico.conflist
```

### Calico-Specific Debugging

```bash
# Get the calico-node pod name on a specific node
CALICO_POD=$(kubectl get pod -n kube-system -l k8s-app=calico-node \
  --field-selector spec.nodeName=worker-node-01 -o name | head -1)

# Check Calico node status
kubectl exec -n kube-system "$CALICO_POD" -- calico-node -bird-live

# Check BGP peer status (if using BGP mode)
kubectl exec -n kube-system "$CALICO_POD" -- birdcl show protocols

# Check BGP routes
kubectl exec -n kube-system "$CALICO_POD" -- birdcl show route

# Check IP pool allocation
kubectl get ippool -o yaml

# Verify IPAM block allocations
kubectl exec -n kube-system "$CALICO_POD" -- calico-ipam show --show-blocks

# Check Felix configuration and status
kubectl exec -n kube-system "$CALICO_POD" -- calico-node -felix-live
```

### Cilium-Specific Debugging

```bash
# Get cilium pod on a specific node
CILIUM_POD=$(kubectl get pod -n kube-system -l k8s-app=cilium \
  --field-selector spec.nodeName=worker-node-01 -o name | head -1)

# Check overall Cilium status
kubectl exec -n kube-system "$CILIUM_POD" -- cilium status --verbose

# List all managed endpoints
kubectl exec -n kube-system "$CILIUM_POD" -- cilium endpoint list

# Run built-in connectivity test
kubectl exec -n kube-system "$CILIUM_POD" -- cilium connectivity test

# Monitor dropped packets in real time
kubectl exec -n kube-system "$CILIUM_POD" -- cilium monitor --type drop

# Check BPF map entries for a specific service
SERVICE_IP=$(kubectl get svc my-service -o jsonpath='{.spec.clusterIP}')
kubectl exec -n kube-system "$CILIUM_POD" -- cilium bpf lb list | grep "$SERVICE_IP"

# Verify eBPF programs are loaded
kubectl exec -n kube-system "$CILIUM_POD" -- cilium bpf prog list
```

### Pod Network Interface Inspection

```bash
# Use an ephemeral debug container to inspect pod networking
kubectl debug -it nettest-node1 --image=nicolaka/netshoot --target=netshoot

# Inside the debug container, run these commands:
# ip addr show          -- Network interfaces and IPs
# ip route show         -- Routing table
# ip neigh show         -- ARP cache
# ss -tuln             -- Listening sockets
# cat /etc/resolv.conf  -- DNS configuration
# iptables -L -n       -- iptables rules (if privileged)

# Find the pod's veth pair on the host
# Step 1: Get the interface index inside the pod
kubectl exec nettest-node1 -- cat /sys/class/net/eth0/iflink

# Step 2: On the node, match the interface index to a veth
kubectl run veth-finder --image=nicolaka/netshoot --rm -it --restart=Never \
  --overrides='{"spec":{"hostNetwork":true,"nodeName":"worker-node-01","containers":[{"name":"finder","image":"nicolaka/netshoot","command":["sh","-c","ip link show | grep -A1 ^\$(cat /sys/class/net/*/ifindex | grep -n 25 | cut -d: -f1):"],"securityContext":{"privileged":true}}]}}'
```

## Section 3: Packet Capture with tcpdump and tshark

Packet captures provide ground truth for network debugging. The challenge in Kubernetes is getting captures from the right network namespace.

### Capturing on a Pod's Network Interface

```bash
# Method 1: Run tcpdump directly in the pod
kubectl exec nettest-node1 -- tcpdump -i eth0 -nn -c 100 -w /tmp/capture.pcap

# Copy the capture file to your workstation
kubectl cp nettest-node1:/tmp/capture.pcap ./node1-capture.pcap

# Method 2: Use an ephemeral debug container with packet capture
kubectl debug -it nettest-node1 --image=nicolaka/netshoot --target=netshoot \
  -- tcpdump -i eth0 -nn -w /tmp/capture.pcap 'host 10.244.2.15'

# Method 3: Real-time capture with output to stdout (no file needed)
kubectl exec nettest-node1 -- tcpdump -i eth0 -nn -l -A 'tcp port 8080' | head -100
```

### Finding the veth Interface for a Pod

```bash
#!/bin/bash
# find-pod-veth.sh
# Usage: ./find-pod-veth.sh <pod-name> <namespace>

POD_NAME=${1:-nettest-node1}
NAMESPACE=${2:-default}

NODE=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.nodeName}')
POD_IP=$(kubectl get pod "$POD_NAME" -n "$NAMESPACE" -o jsonpath='{.status.podIP}')

echo "Pod $POD_NAME is on node $NODE with IP $POD_IP"

# Get the interface index inside the pod
IFLINK=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- cat /sys/class/net/eth0/iflink 2>/dev/null)
echo "Pod eth0 iflink index: $IFLINK"

# On the node, find the matching veth
kubectl run veth-probe-$$ --image=nicolaka/netshoot --rm --restart=Never \
  --overrides="{\"spec\":{\"hostNetwork\":true,\"nodeName\":\"$NODE\",\"containers\":[{\"name\":\"probe\",\"image\":\"nicolaka/netshoot\",\"command\":[\"sh\",\"-c\",\"ip link show | awk '/^$IFLINK:/{print \\\$2}'\"],\"securityContext\":{\"privileged\":true}}]}}" \
  2>/dev/null
echo "Use the veth interface name above for tcpdump on the node"
```

### Capturing with tshark for Application-Level Analysis

```bash
# Deploy a debug pod with packet capture capability
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: tshark-debug
  namespace: default
spec:
  containers:
  - name: netshoot
    image: nicolaka/netshoot
    command: ["sleep", "3600"]
    securityContext:
      capabilities:
        add: ["NET_ADMIN", "NET_RAW"]
EOF

# Capture HTTP traffic and decode fields
kubectl exec tshark-debug -- tshark -i eth0 -nn \
  -Y 'http' \
  -T fields \
  -e frame.time \
  -e ip.src \
  -e ip.dst \
  -e http.request.method \
  -e http.request.uri \
  -e http.response.code \
  -E header=y

# Capture and analyze DNS traffic
kubectl exec tshark-debug -- tshark -i eth0 -nn \
  -Y 'dns' \
  -T fields \
  -e frame.time \
  -e ip.src \
  -e dns.qry.name \
  -e dns.resp.name \
  -e dns.a \
  -E header=y \
  -l 2>/dev/null | head -50

# Capture TCP connection failures (RST packets and ICMP unreachable)
kubectl exec tshark-debug -- tshark -i eth0 -nn \
  -Y 'tcp.flags.reset == 1 or icmp.type == 3' \
  -T fields \
  -e frame.time \
  -e ip.src \
  -e ip.dst \
  -e tcp.flags \
  -e icmp.type \
  -E header=y
```

### Analyzing Captures for Common Issues

```bash
# Summarize connections from a capture file
tcpdump -r capture.pcap -nn 'tcp[tcpflags] & tcp-syn != 0' | \
  awk '{print $3, $5}' | sed 's/\.[0-9]*$//' | \
  sort | uniq -c | sort -rn | head -20

# Find slow connections (high RTT) using tshark
tshark -r capture.pcap \
  -Y 'tcp.analysis.ack_rtt > 0.1' \
  -T fields \
  -e frame.time \
  -e tcp.stream \
  -e tcp.analysis.ack_rtt \
  -e ip.src \
  -e ip.dst \
  -E header=y

# Count retransmissions per source IP
tshark -r capture.pcap \
  -Y 'tcp.analysis.retransmission' \
  -T fields \
  -e ip.src \
  | sort | uniq -c | sort -rn

# Check for ICMP destination unreachable messages
tshark -r capture.pcap \
  -Y 'icmp.type == 3' \
  -T fields \
  -e frame.time \
  -e ip.src \
  -e ip.dst \
  -e icmp.code \
  -E header=y
```

## Section 4: DNS Resolution Debugging

DNS failures in Kubernetes often manifest as intermittent application errors, slow response times, or complete service unavailability. CoreDNS is the default DNS provider, and its health directly impacts all service discovery.

### CoreDNS Health Check

```bash
# Check CoreDNS pods and their node placement
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide

# Check CoreDNS logs for errors
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=100 | \
  grep -E 'error|SERVFAIL|REFUSED|plugin/errors'

# Verify CoreDNS endpoints are healthy
kubectl get endpoints kube-dns -n kube-system

# Check CoreDNS metrics (if port 9153 is accessible)
COREDNS_POD=$(kubectl get pod -n kube-system -l k8s-app=kube-dns -o name | head -1)
kubectl exec -n kube-system "$COREDNS_POD" -- wget -qO- http://localhost:9153/metrics | \
  grep -E 'coredns_dns_requests_total|coredns_dns_responses_total|coredns_cache'
```

### DNS Resolution Testing

```bash
# Deploy a persistent DNS test pod
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: dns-test
  namespace: default
spec:
  containers:
  - name: dnsutils
    image: nicolaka/netshoot
    command: ["sleep", "3600"]
EOF

kubectl wait pod/dns-test --for=condition=Ready --timeout=30s

# Test internal service resolution
kubectl exec dns-test -- dig kubernetes.default.svc.cluster.local +short

# Test across namespaces
kubectl exec dns-test -- dig my-service.production.svc.cluster.local +short

# Test SRV records for service port discovery
kubectl exec dns-test -- dig _http._tcp.my-service.production.svc.cluster.local SRV

# Test external DNS resolution
kubectl exec dns-test -- dig google.com @8.8.8.8 +short

# Test with nslookup for application-style resolution
kubectl exec dns-test -- nslookup kubernetes.default

# Check resolv.conf configuration
kubectl exec dns-test -- cat /etc/resolv.conf

# Measure DNS resolution latency
kubectl exec dns-test -- sh -c '
for i in $(seq 1 50); do
  start=$(date +%s%3N)
  dig +short kubernetes.default.svc.cluster.local > /dev/null
  end=$(date +%s%3N)
  echo $((end - start))
done | awk "NR==1{min=\$1} {sum+=\$1; if(\$1>max)max=\$1; if(\$1<min)min=\$1} END{printf \"min=%dms avg=%dms max=%dms\n\",min,sum/NR,max}"
'
```

### Production-Ready CoreDNS Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
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
            prefer_udp
        }
        cache {
            success 9984 30
            denial 9984 5
            prefetch 10 1m 10%
        }
        loop
        reload
        loadbalance round_robin
        log . {
            class error
        }
    }

    internal.company.com:53 {
        errors
        forward . 10.10.0.53 10.10.0.54 {
            policy sequential
            health_check 10s
        }
        cache 30
        log
    }
```

### Diagnosing DNS Latency with ndots

```bash
# The ndots setting causes search domain expansion
# With ndots:5 (default), a name like "my-service" triggers these queries in order:
# 1. my-service.default.svc.cluster.local
# 2. my-service.svc.cluster.local
# 3. my-service.cluster.local
# 4. my-service.ec2.internal (from host resolv.conf)
# 5. my-service (bare)
# This adds latency for any external DNS name with fewer than 5 dots

# Test the ndots penalty
kubectl exec dns-test -- sh -c '
echo "=== FQDN query (no search expansion) ==="
time dig +short my-service.default.svc.cluster.local.

echo "=== Short name query (triggers search expansion) ==="
time dig +short my-service
'
```

### Optimizing ndots for Applications

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: optimized-dns-pod
spec:
  dnsConfig:
    options:
    - name: ndots
      value: "2"
    - name: single-request-reopen
    - name: timeout
      value: "2"
    - name: attempts
      value: "3"
  containers:
  - name: app
    image: my-app:1.2.3
    env:
    - name: MY_SERVICE_URL
      # Use FQDN with trailing dot to bypass ndots entirely
      value: "http://my-service.production.svc.cluster.local.:8080"
```

### CoreDNS Scaling

```bash
# Check current CoreDNS resource usage
kubectl top pods -n kube-system -l k8s-app=kube-dns

# Check cache hit rate
COREDNS_POD=$(kubectl get pod -n kube-system -l k8s-app=kube-dns -o name | head -1)
kubectl exec -n kube-system "$COREDNS_POD" -- wget -qO- http://localhost:9153/metrics | \
  grep coredns_cache_hits_total

# Scale CoreDNS for high query load
kubectl scale deployment coredns -n kube-system --replicas=4

# Apply HPA for automatic scaling
kubectl apply -f - <<'EOF'
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: coredns
  namespace: kube-system
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: coredns
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
EOF
```

## Section 5: kube-proxy Modes - iptables vs IPVS

kube-proxy implements Kubernetes service load balancing. The choice between iptables and IPVS modes significantly affects performance and troubleshooting approach.

### Identifying the Current kube-proxy Mode

```bash
# Check kube-proxy configuration
kubectl get configmap kube-proxy -n kube-system -o yaml | grep -A 3 mode

# Check kube-proxy logs for mode confirmation
kubectl logs -n kube-system -l k8s-app=kube-proxy --tail=30 | grep -i 'using.*mode\|mode.*proxy'

# Verify IPVS modules are loaded (required for IPVS mode)
kubectl run ipvs-check --image=nicolaka/netshoot --rm -it --restart=Never \
  --overrides='{"spec":{"hostNetwork":true,"nodeName":"worker-node-01","containers":[{"name":"check","image":"nicolaka/netshoot","command":["sh","-c","lsmod | grep -E ip_vs; ipvsadm -L -n 2>/dev/null | head -20"],"securityContext":{"privileged":true}}]}}'
```

### Debugging iptables Mode

```bash
# Get service cluster IP
SERVICE_CLUSTER_IP=$(kubectl get svc my-service -o jsonpath='{.spec.clusterIP}')
echo "Service ClusterIP: $SERVICE_CLUSTER_IP"

# Check iptables rules on a node using a privileged pod
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: iptables-debug
spec:
  nodeName: worker-node-01
  hostNetwork: true
  containers:
  - name: debug
    image: nicolaka/netshoot
    command: ["sleep", "3600"]
    securityContext:
      privileged: true
EOF

# Check KUBE-SERVICES chain for the service
kubectl exec iptables-debug -- iptables -t nat -L KUBE-SERVICES -n -v | \
  grep "$SERVICE_CLUSTER_IP"

# Follow the chain to see backend selection
# First, get the service chain name
SVC_CHAIN=$(kubectl exec iptables-debug -- iptables -t nat -L KUBE-SERVICES -n | \
  grep "$SERVICE_CLUSTER_IP" | awk '{print $NF}')

echo "Service chain: $SVC_CHAIN"
kubectl exec iptables-debug -- iptables -t nat -L "$SVC_CHAIN" -n -v

# Count total rules (performance indicator - large rule counts slow packet processing)
kubectl exec iptables-debug -- iptables -t nat -L --line-numbers | wc -l
```

### Debugging IPVS Mode

```bash
# IPVS mode is more performant and uses hash tables instead of linear rules
# List all virtual servers
kubectl run ipvs-debug --image=nicolaka/netshoot --rm -it --restart=Never \
  --overrides='{"spec":{"hostNetwork":true,"nodeName":"worker-node-01","containers":[{"name":"debug","image":"nicolaka/netshoot","command":["sh"],"stdin":true,"tty":true,"securityContext":{"privileged":true}}]}}'

# Inside the pod:
# ipvsadm -L -n --stats      -- All virtual servers with statistics
# ipvsadm -L -n -t $CLUSTER_IP:80  -- Specific service
# ip addr show kube-ipvs0    -- Virtual IPs bound to dummy interface
# ipvsadm --save > /tmp/ipvs-rules.txt  -- Save current state
```

### kube-proxy IPVS Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-proxy
  namespace: kube-system
data:
  config.conf: |
    apiVersion: kubeproxy.config.k8s.io/v1alpha1
    kind: KubeProxyConfiguration
    mode: "ipvs"
    ipvs:
      scheduler: "lc"
      syncPeriod: "30s"
      minSyncPeriod: "2s"
      tcpTimeout: "900s"
      tcpFinTimeout: "120s"
      udpTimeout: "300s"
    iptables:
      masqueradeAll: false
      masqueradeBit: 14
      minSyncPeriod: "0s"
      syncPeriod: "30s"
    conntrack:
      maxPerCore: 32768
      min: 131072
      tcpEstablishedTimeout: "86400s"
      tcpCloseWaitTimeout: "3600s"
    featureGates:
      SupportIPVSProxyMode: true
```

## Section 6: NetworkPolicy Testing and Debugging

NetworkPolicy failures are common because policies are additive (default-allow when no policies exist) and whitelist-based once any policy is applied to a pod.

### Understanding NetworkPolicy Behavior

Key rules for NetworkPolicy:
- Without any policies: all traffic is allowed
- With any ingress policy on a pod: all ingress not explicitly allowed is denied
- With any egress policy on a pod: all egress not explicitly allowed is denied
- Policies are per-pod, not per-namespace (the namespace selector affects which pods a policy applies to)

```bash
# List all NetworkPolicies in a namespace
kubectl get networkpolicy -n production -o wide

# Show the effective rules on a specific pod
kubectl describe networkpolicy -n production

# Test connectivity before applying any policies
kubectl run baseline-test --image=nicolaka/netshoot --rm -it --restart=Never \
  -n production -- curl -v --max-time 5 http://api-service.production.svc.cluster.local/health
```

### Comprehensive NetworkPolicy Example

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-server-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-server
      tier: backend
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Allow from frontend pods in the same namespace
  - from:
    - podSelector:
        matchLabels:
          app: frontend
          tier: web
    ports:
    - protocol: TCP
      port: 8080
  # Allow from monitoring namespace (Prometheus scraping)
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app: prometheus
    ports:
    - protocol: TCP
      port: 9090
  # Allow health checks from kubelet (node CIDR)
  - from:
    - ipBlock:
        cidr: 192.168.10.0/24
    ports:
    - protocol: TCP
      port: 8080
  egress:
  # Allow DNS queries to CoreDNS
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
  # Allow egress to database
  - to:
    - podSelector:
        matchLabels:
          app: postgresql
    ports:
    - protocol: TCP
      port: 5432
  # Allow egress to external HTTPS APIs only
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8
        - 172.16.0.0/12
        - 192.168.0.0/16
    ports:
    - protocol: TCP
      port: 443
```

### Systematic NetworkPolicy Testing Script

```bash
#!/bin/bash
# test-netpolicy.sh - Verify NetworkPolicy enforcement

NAMESPACE="production"
TARGET_SVC="api-service"
TARGET_PORT="8080"

echo "=== NetworkPolicy Test Suite ==="
echo "Target: $TARGET_SVC:$TARGET_PORT in $NAMESPACE"
echo ""

# Test 1: Allowed source (matching labels)
echo "Test 1: Allowed source (frontend label)"
RESULT=$(kubectl run test-allowed-$$ --image=curlimages/curl:7.87.0 \
  --rm --restart=Never -n "$NAMESPACE" \
  --labels="app=frontend,tier=web" \
  --command -- curl -s --max-time 5 \
  "http://$TARGET_SVC.$NAMESPACE.svc.cluster.local:$TARGET_PORT/health" \
  2>&1)
if echo "$RESULT" | grep -q 'ok\|healthy\|200'; then
  echo "  PASS: Allowed traffic reached the service"
else
  echo "  FAIL: Expected allowed traffic was blocked"
  echo "  Output: $RESULT"
fi

# Test 2: Denied source (no matching labels)
echo "Test 2: Denied source (no matching labels)"
RESULT=$(kubectl run test-denied-$$ --image=curlimages/curl:7.87.0 \
  --rm --restart=Never -n "$NAMESPACE" \
  --command -- curl -s --max-time 5 \
  "http://$TARGET_SVC.$NAMESPACE.svc.cluster.local:$TARGET_PORT/health" \
  2>&1)
if echo "$RESULT" | grep -q 'timed out\|Connection refused\|Could not connect'; then
  echo "  PASS: Denied traffic was correctly blocked"
else
  echo "  FAIL: Denied traffic was not blocked"
  echo "  Output: $RESULT"
fi

# Test 3: Cross-namespace denied
echo "Test 3: Cross-namespace (should be denied)"
RESULT=$(kubectl run test-crossns-$$ --image=curlimages/curl:7.87.0 \
  --rm --restart=Never -n default \
  --command -- curl -s --max-time 5 \
  "http://$TARGET_SVC.$NAMESPACE.svc.cluster.local:$TARGET_PORT/health" \
  2>&1)
if echo "$RESULT" | grep -q 'timed out\|Connection refused\|Could not connect'; then
  echo "  PASS: Cross-namespace traffic was correctly blocked"
else
  echo "  WARN: Cross-namespace traffic may not be blocked"
  echo "  Output: $RESULT"
fi

echo ""
echo "Test suite complete"
```

### Debugging NetworkPolicy with Cilium

```bash
# Generate a connectivity trace between two pods
kubectl exec -n kube-system "$CILIUM_POD" -- cilium policy trace \
  --src-k8s-pod production/frontend-pod-abc123 \
  --dst-k8s-pod production/api-server-pod-xyz789 \
  --dport 8080/TCP

# Check policy verdicts in real time
kubectl exec -n kube-system "$CILIUM_POD" -- cilium monitor \
  --type policy-verdict \
  --from production/frontend-pod-abc123

# Get the Cilium endpoint ID for a pod
ENDPOINT_ID=$(kubectl exec -n kube-system "$CILIUM_POD" -- \
  cilium endpoint list -o json | \
  jq -r '.[] | select(.status.labels["k8s:app"] == "api-server") | .id' | head -1)

# View the security policy for this endpoint
kubectl exec -n kube-system "$CILIUM_POD" -- cilium endpoint get "$ENDPOINT_ID" -o json | \
  jq '.spec.policy'
```

## Section 7: MTU Issues

MTU mismatches cause intermittent failures, particularly with overlay networks where encapsulation adds overhead. Symptoms include large transfers failing while small requests succeed, and SSH sessions hanging after connecting.

### Identifying MTU Issues

```bash
# Check MTU on pod interfaces
kubectl exec nettest-node1 -- ip link show eth0 | grep mtu

# Check MTU on node interfaces
kubectl run mtu-check --image=nicolaka/netshoot --rm -it --restart=Never \
  --overrides='{"spec":{"hostNetwork":true,"nodeName":"worker-node-01"}}' \
  -- ip link show

# Test with specific packet sizes using ping with DF bit set
# This tests if packets larger than a certain size get dropped
kubectl exec nettest-node1 -- sh -c '
echo "Testing MTU sizes (no fragmentation)"
for size in 1472 1450 1400 1300; do
  result=$(ping -c 2 -M do -s "$size" '"$NODE2_POD_IP"' 2>&1)
  if echo "$result" | grep -q "transmitted"; then
    echo "Size $size: OK"
  else
    echo "Size $size: FAILED (packets dropped)"
  fi
done
'

# Use tracepath to discover path MTU
kubectl exec nettest-node1 -- tracepath -n "$NODE2_POD_IP"
```

### MTU Configuration by CNI Plugin

```bash
# Flannel VXLAN: overhead is 50 bytes (8 VXLAN + 14 Eth + 20 IP + 8 UDP)
# Host MTU 1500 -> Pod MTU should be 1450

# Calico VXLAN: similar to Flannel
# Pod MTU: 1450

# Calico BGP (no encapsulation): full MTU available
# If host uses jumbo frames (9000): pods can use up to 8980

# Cilium VXLAN: Pod MTU should be 1450
# Cilium Geneve: Pod MTU should be 1450
# Cilium native routing: full host MTU available

# Check current Calico MTU setting
kubectl get felixconfiguration default -o jsonpath='{.spec.mtu}' 2>/dev/null || echo "not set"

# Check Flannel config
kubectl get configmap kube-flannel-cfg -n kube-flannel -o yaml 2>/dev/null | grep -A 10 net-conf.json
```

### Fixing MTU Configuration

```yaml
# Flannel MTU configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-flannel-cfg
  namespace: kube-flannel
data:
  net-conf.json: |
    {
      "Network": "10.244.0.0/16",
      "EnableIPv6": false,
      "Backend": {
        "Type": "vxlan",
        "VNI": 1,
        "Port": 4789,
        "MTU": 1450
      }
    }
---
# Calico MTU configuration
apiVersion: projectcalico.org/v3
kind: FelixConfiguration
metadata:
  name: default
spec:
  mtu: 1450
  vxlanEnabled: true
  vxlanPort: 4789
  vxlanVNI: 4096
---
# Cilium MTU configuration in Helm values
# helm upgrade cilium cilium/cilium --set MTU=1450
```

## Section 8: Ephemeral Debug Containers

Kubernetes 1.23+ supports ephemeral debug containers, allowing a debugging container to be attached to a running pod without restarting it. This is critical for production debugging where pod restarts would lose state or cause service disruption.

### Using Ephemeral Debug Containers

```bash
# Basic ephemeral container attach
kubectl debug -it my-app-pod --image=nicolaka/netshoot --target=app-container

# The --target flag shares the process namespace with the target container
# This allows you to see the target container's file descriptors and processes
# Inside the debug container:
# ip addr show       -- Pod's network interfaces (shared network namespace)
# ss -tuln           -- Ports the target container is listening on
# ls /proc/1/fd      -- File descriptors of the main process
# cat /proc/1/net/tcp -- TCP connections in hex format

# Debug a node directly
kubectl debug node/worker-node-01 -it --image=nicolaka/netshoot
# This creates a pod with hostPID, hostNetwork, and a chroot to /host
# Inside: chroot /host to access node filesystem
# nsenter -t 1 -m -u -i -n -p -- bash  -- Full node shell

# Create a copy of a pod with debug tools added
kubectl debug my-app-pod -it \
  --image=nicolaka/netshoot \
  --copy-to=my-app-debug \
  --share-processes \
  --set-image=app-container=nicolaka/netshoot
```

### Ephemeral Container Security Policies

Some clusters restrict privileged containers. Use the minimum required capabilities:

```yaml
# Ephemeral container with specific capabilities for network debugging
# Applied via kubectl patch
apiVersion: v1
kind: EphemeralContainers
metadata:
  name: my-app-pod
spec:
  ephemeralContainers:
  - name: netdebug
    image: nicolaka/netshoot
    stdin: true
    tty: true
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
        - SYS_PTRACE
      runAsNonRoot: false
      runAsUser: 0
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
```

### Production Debug Image

```dockerfile
FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    iproute2 \
    iputils-ping \
    tcpdump \
    tshark \
    netcat-openbsd \
    curl \
    wget \
    dnsutils \
    net-tools \
    nmap \
    traceroute \
    mtr-tiny \
    iperf3 \
    strace \
    lsof \
    procps \
    jq \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LO \
    "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

# Use a non-root user by default; override with -u 0 when needed
RUN useradd -m -u 1000 -s /bin/bash debugger
USER 1000

CMD ["/bin/bash"]
```

## Section 9: Service Connectivity Debugging

### End-to-End Service Resolution Trace

```bash
#!/bin/bash
# trace-service.sh - Trace complete service connectivity path

SVC_NAME=${1:-my-service}
NAMESPACE=${2:-default}
TEST_PORT=${3:-80}

echo "=== Tracing service: $SVC_NAME in $NAMESPACE ==="

# Step 1: Service exists and has ClusterIP
echo ""
echo "Step 1: Service configuration"
kubectl get svc "$SVC_NAME" -n "$NAMESPACE" -o wide
CLUSTER_IP=$(kubectl get svc "$SVC_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}')
echo "ClusterIP: $CLUSTER_IP"

# Step 2: Endpoints are populated
echo ""
echo "Step 2: Endpoint addresses"
kubectl get endpoints "$SVC_NAME" -n "$NAMESPACE"
ENDPOINT_IPS=$(kubectl get endpoints "$SVC_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.subsets[*].addresses[*].ip}')
echo "Endpoint IPs: $ENDPOINT_IPS"

# Step 3: Pod label matching
echo ""
echo "Step 3: Pods matching service selector"
SELECTOR=$(kubectl get svc "$SVC_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.spec.selector}' | jq -r 'to_entries | map("\(.key)=\(.value)") | join(",")')
echo "Selector: $SELECTOR"
kubectl get pods -n "$NAMESPACE" -l "$SELECTOR" -o wide

# Step 4: Pod readiness
echo ""
echo "Step 4: Pod readiness status"
kubectl get pods -n "$NAMESPACE" -l "$SELECTOR" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

# Step 5: Direct pod connectivity
echo ""
echo "Step 5: Direct pod connectivity test"
for ip in $ENDPOINT_IPS; do
  echo -n "  Testing $ip:$TEST_PORT ... "
  kubectl run conn-test-$$ --image=curlimages/curl:7.87.0 --rm --restart=Never \
    -n "$NAMESPACE" --command -- \
    curl -s --max-time 5 "http://$ip:$TEST_PORT/health" 2>&1 | head -1
done

# Step 6: ClusterIP connectivity
echo ""
echo "Step 6: ClusterIP connectivity test"
kubectl run cluster-ip-test-$$ --image=curlimages/curl:7.87.0 --rm --restart=Never \
  -n "$NAMESPACE" --command -- \
  curl -sv --max-time 5 "http://$CLUSTER_IP:$TEST_PORT/health" 2>&1

# Step 7: DNS-based connectivity
echo ""
echo "Step 7: DNS-based connectivity test"
kubectl run dns-conn-test-$$ --image=curlimages/curl:7.87.0 --rm --restart=Never \
  -n "$NAMESPACE" --command -- \
  curl -sv --max-time 5 \
  "http://$SVC_NAME.$NAMESPACE.svc.cluster.local:$TEST_PORT/health" 2>&1

echo ""
echo "=== Trace complete ==="
```

## Section 10: Network Performance Testing

### Bandwidth and Latency Benchmarking

```bash
# Deploy iperf3 server on a specific node
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: iperf3-server
  labels:
    app: iperf3-server
spec:
  nodeName: worker-node-01
  containers:
  - name: iperf3
    image: networkstatic/iperf3
    args: ["-s"]
    ports:
    - containerPort: 5201
---
apiVersion: v1
kind: Service
metadata:
  name: iperf3-server
spec:
  selector:
    app: iperf3-server
  ports:
  - port: 5201
    targetPort: 5201
EOF

kubectl wait pod/iperf3-server --for=condition=Ready --timeout=60s

# Test TCP throughput from another node
kubectl run iperf3-client --image=networkstatic/iperf3 --rm -it --restart=Never \
  --overrides='{"spec":{"nodeName":"worker-node-02"}}' \
  -- -c iperf3-server -P 8 -t 30 -i 5

# Test with 1400-byte blocks to validate MTU (avoids fragmentation)
kubectl run iperf3-mtu --image=networkstatic/iperf3 --rm -it --restart=Never \
  --overrides='{"spec":{"nodeName":"worker-node-02"}}' \
  -- -c iperf3-server -l 1400 -P 4 -t 10

# UDP throughput and packet loss test
kubectl run iperf3-udp --image=networkstatic/iperf3 --rm -it --restart=Never \
  --overrides='{"spec":{"nodeName":"worker-node-02"}}' \
  -- -c iperf3-server -u -b 1G -t 10
```

## Section 11: Automated Network Diagnostics Script

```bash
#!/bin/bash
# k8s-net-diag.sh - Automated network diagnostics collection
set -euo pipefail

NAMESPACE="${1:-default}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_DIR="/tmp/k8s-netdiag-$TIMESTAMP"
mkdir -p "$LOG_DIR"

log() {
  echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_DIR/diag.log"
}

log "Starting Kubernetes network diagnostics for namespace: $NAMESPACE"
log "Output directory: $LOG_DIR"

# Cluster overview
log "=== Collecting cluster overview ==="
kubectl get nodes -o wide > "$LOG_DIR/nodes.txt" 2>&1
kubectl get pods -n kube-system -o wide > "$LOG_DIR/kube-system-pods.txt" 2>&1
kubectl top nodes > "$LOG_DIR/node-resources.txt" 2>&1 || true

# CNI status
log "=== Collecting CNI status ==="
for cni in calico-node cilium flannel weave; do
  PODS=$(kubectl get pods -n kube-system -l "k8s-app=$cni" -o name 2>/dev/null)
  if [ -n "$PODS" ]; then
    log "Found CNI: $cni"
    echo "$PODS" | while read -r pod; do
      kubectl logs -n kube-system "$pod" --tail=100 > "$LOG_DIR/cni-$cni-${pod##*/}.txt" 2>&1 || true
    done
  fi
done

# CoreDNS status
log "=== Collecting CoreDNS status ==="
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide > "$LOG_DIR/coredns-pods.txt" 2>&1
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=200 > "$LOG_DIR/coredns-logs.txt" 2>&1 || true
kubectl get configmap coredns -n kube-system -o yaml > "$LOG_DIR/coredns-config.txt" 2>&1
kubectl get endpoints kube-dns -n kube-system > "$LOG_DIR/coredns-endpoints.txt" 2>&1

# kube-proxy status
log "=== Collecting kube-proxy status ==="
kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide > "$LOG_DIR/kube-proxy-pods.txt" 2>&1
kubectl logs -n kube-system -l k8s-app=kube-proxy --tail=100 > "$LOG_DIR/kube-proxy-logs.txt" 2>&1 || true
kubectl get configmap kube-proxy -n kube-system -o yaml > "$LOG_DIR/kube-proxy-config.txt" 2>&1 || true

# Namespace network state
log "=== Collecting namespace network state for: $NAMESPACE ==="
kubectl get svc -n "$NAMESPACE" -o wide > "$LOG_DIR/services.txt" 2>&1
kubectl get endpoints -n "$NAMESPACE" > "$LOG_DIR/endpoints.txt" 2>&1
kubectl get networkpolicy -n "$NAMESPACE" -o yaml > "$LOG_DIR/network-policies.txt" 2>&1

# DNS test
log "=== Running DNS resolution test ==="
kubectl run dns-diag-$$ --image=nicolaka/netshoot --rm --restart=Never \
  -n "$NAMESPACE" \
  -- sh -c 'echo "=== resolv.conf ==="; cat /etc/resolv.conf; echo "=== kubernetes.default ==="; dig kubernetes.default.svc.cluster.local +short; echo "=== external DNS ==="; dig google.com +short' \
  > "$LOG_DIR/dns-test.txt" 2>&1 || log "DNS test pod failed"

# Create archive
ARCHIVE="k8s-netdiag-$TIMESTAMP.tar.gz"
tar -czf "/tmp/$ARCHIVE" -C /tmp "k8s-netdiag-$TIMESTAMP"
log "Diagnostics complete. Archive: /tmp/$ARCHIVE"
echo ""
echo "Share /tmp/$ARCHIVE with your support team."
```

## Summary

Effective Kubernetes network troubleshooting requires systematic layer-by-layer investigation:

1. Verify node-level connectivity before investigating pod networking
2. Check CNI plugin health and logs before assuming application issues
3. Use ephemeral debug containers to inspect running pods without disruption
4. Capture packets at the correct network namespace layer with tcpdump or tshark
5. Validate DNS resolution separately from TCP connectivity, paying attention to ndots and search domain expansion
6. Test NetworkPolicy enforcement with labeled test pods that match and do not match the policy selectors
7. Verify MTU settings match the overlay network's encapsulation overhead
8. Choose the right diagnostic tools based on kube-proxy mode (iptables vs ipvsadm)

The automated diagnostics script at the end of this guide provides a starting point for incident response runbooks. Run it as the first step when a network complaint arrives, and the collected data will contain the evidence needed to resolve most issues without requiring prolonged interactive debugging sessions.
