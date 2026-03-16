---
title: "Kubernetes Network Troubleshooting: DNS, CNI, Pod Connectivity, and Service Issues"
date: 2027-05-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Troubleshooting", "DNS", "CNI", "Debugging"]
categories: ["Kubernetes", "Troubleshooting"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A systematic guide to diagnosing and resolving Kubernetes network problems including DNS failures, CNI plugin issues, pod connectivity problems, Service routing, and NetworkPolicy debugging with real-world commands and packet capture techniques."
more_link: "yes"
url: "/kubernetes-network-troubleshooting-guide/"
---

Network failures in Kubernetes are among the most time-consuming incidents to diagnose because the networking stack involves multiple independent components: the CNI plugin, kube-proxy, CoreDNS, the service abstraction layer, iptables or IPVS rules, and the underlying node network. A problem at any layer can manifest as identical symptoms — connection refused, connection timeout, or DNS resolution failure — with completely different root causes. This guide provides a structured troubleshooting methodology and the specific commands needed at each layer.

<!--more-->

## Troubleshooting Methodology

### The Five-Layer Network Stack

Effective Kubernetes network troubleshooting requires checking each layer independently before drawing conclusions. The layers from bottom to top:

1. **Node network** — Physical/virtual network between nodes. Checks: node-to-node ping, MTU consistency, firewall rules blocking required ports (6443, 2379, 10250, 10251, 10252, 4789, 8472, and CNI-specific ports).

2. **CNI plugin** — Assigns pod IPs, programs routing, and manages network policies. Checks: pod CIDR assignment, CNI plugin pod health, route tables on nodes, ARP tables.

3. **kube-proxy** — Programs iptables or IPVS rules for Service VIPs. Checks: kube-proxy pod health, iptables chain completeness, IPVS table entries.

4. **CoreDNS** — Resolves Kubernetes Service names to ClusterIPs. Checks: CoreDNS pod health, ConfigMap correctness, upstream forwarding.

5. **Application layer** — TLS certificates, connection pooling, health check paths. Checks: application logs, certificate validity, HTTP status codes.

Start at layer 1 and work upward. A missing route at layer 2 will cause failures at layers 3, 4, and 5 simultaneously. Jumping straight to CoreDNS debugging when the node network is misconfigured wastes significant time.

### Essential Debugging Tools

```bash
# The netshoot container — includes every network debugging tool needed
# Run as an ephemeral debug container against a running pod
kubectl debug -it <pod-name> \
  --image=nicolaka/netshoot \
  --target=<container-name> \
  -n <namespace>

# Or run as a standalone debug pod
kubectl run netshoot \
  --rm -it \
  --image=nicolaka/netshoot \
  --restart=Never \
  -- bash

# Run on a specific node (to debug host networking)
kubectl run netshoot-node \
  --rm -it \
  --image=nicolaka/netshoot \
  --restart=Never \
  --overrides='{"spec": {"nodeName": "worker-01", "hostNetwork": true, "hostPID": true}}' \
  -- bash
```

## Layer 1: Node Network Verification

### Verifying Node-to-Node Connectivity

```bash
# Check that all nodes are Ready
kubectl get nodes -o wide

# Get node IPs
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}'

# From node worker-01, verify connectivity to worker-02
# (SSH to the node or use a privileged pod with hostNetwork)
ping -c 4 <worker-02-ip>

# Verify required ports are open (use netcat)
# kube-apiserver
nc -zv <control-plane-ip> 6443

# kubelet
nc -zv <worker-ip> 10250

# CNI overlay ports (for Flannel VXLAN)
nc -zu <worker-ip> 8472

# CNI overlay ports (for Calico VXLAN)
nc -zu <worker-ip> 4789

# Check MTU on all interfaces — mismatch causes silent packet drops
# On the node:
ip link show | grep mtu

# The pod network MTU must be smaller than the node network MTU
# For VXLAN overlays: node_mtu - 50 bytes overhead
# For Calico with BGP (no overlay): node_mtu
```

### Identifying Firewall Blocking Kubernetes Traffic

```bash
# On Linux nodes, check iptables for DROP rules that might be blocking traffic
iptables -L -n -v | grep DROP
iptables -L -n -v | grep REJECT

# Check if cloud security groups are blocking traffic
# AWS: Check security group rules
aws ec2 describe-security-groups \
  --filters "Name=group-id,Values=sg-xxx" \
  --query 'SecurityGroups[*].IpPermissions'

# For GCP, check firewall rules
gcloud compute firewall-rules list \
  --filter="network=your-vpc-network" \
  --format="table(name,direction,allowed,sourceRanges)"
```

## Layer 2: CNI Plugin Debugging

### CNI Pod Health

Regardless of which CNI is deployed, start by verifying all CNI pods are running:

```bash
# For Calico
kubectl get pods -n calico-system
kubectl get pods -n kube-system -l k8s-app=calico-node

# For Cilium
kubectl get pods -n kube-system -l k8s-app=cilium
cilium status  # requires cilium CLI

# For Flannel
kubectl get pods -n kube-flannel

# For Weave Net
kubectl get pods -n kube-system -l name=weave-net

# Check for CNI plugin errors on a specific node
kubectl logs -n calico-system daemonset/calico-node -c calico-node | tail -50
kubectl logs -n kube-system daemonset/cilium --since=1h | grep -i error
```

### Pod IP Assignment Failures

When pods stay in `Pending` or `ContainerCreating` with network-related errors:

```bash
# Describe the pod to see events
kubectl describe pod <pod-name> -n <namespace>

# Look for events like:
# "Failed to create pod sandbox: ... networkPlugin cni failed to set up pod"
# "network: failed to set bridge addr"
# "IPAM: failed to allocate for range 0"

# Check if the CNI binary is present on the node
ls -la /opt/cni/bin/
# Expected binaries: calico, flannel, weave, bridge, host-local, loopback, etc.

# Check CNI configuration
ls -la /etc/cni/net.d/
cat /etc/cni/net.d/10-calico.conflist  # or flannel, etc.

# Check IPAM (IP address management) for pool exhaustion
# For Calico:
kubectl get ippools -o wide
kubectl exec -n calico-system deploy/calico-kube-controllers -- \
  ipam check

# For Cilium:
cilium ipam state
kubectl exec -n kube-system ds/cilium -- cilium ipam
```

### Calico-Specific Debugging

```bash
# Check BGP peer status (for Calico BGP deployments)
kubectl exec -n calico-system ds/calico-node -- \
  birdcl -s /var/run/calico/bird.ctl show protocols

# Check routing table on the node
kubectl exec -n calico-system ds/calico-node -- \
  ip route show | grep -v "proto bird"

# Verify Calico node-to-node communication
kubectl exec -n calico-system ds/calico-node -- \
  calico-node -bird-v 4

# Check Felix agent (enforces network policy)
kubectl exec -n calico-system ds/calico-node -c calico-node -- \
  ps aux | grep felix

# Felix log for policy-related drops
kubectl logs -n calico-system ds/calico-node -c calico-node | grep -i "drop\|deny\|policy"

# Verify endpoint programming
kubectl exec -n calico-system deploy/calico-kube-controllers -- \
  calicoctl get workloadendpoints --all-namespaces

# Test specific node routes are programmed
kubectl exec -n calico-system ds/calico-node -- \
  ip route get <pod-ip>
```

### Cilium-Specific Debugging

```bash
# Cilium CLI provides the richest debugging information
# Install: https://github.com/cilium/cilium-cli

# Overall cluster health
cilium status --wait

# Check connectivity between specific endpoints
cilium connectivity test --namespace cilium-test

# Trace a packet flow (excellent for policy debugging)
cilium monitor --type drop

# Check if a specific endpoint is being dropped
ENDPOINT_ID=$(kubectl exec -n kube-system ds/cilium -- \
  cilium endpoint list | grep <pod-ip> | awk '{print $1}')
kubectl exec -n kube-system ds/cilium -- \
  cilium endpoint get ${ENDPOINT_ID}

# Check Cilium network policy verdict
kubectl exec -n kube-system ds/cilium -- \
  cilium policy trace -s <source-pod-ip> -d <dest-pod-ip> --dport 8080

# View eBPF map entries for a pod
kubectl exec -n kube-system ds/cilium -- \
  cilium bpf ct list global | grep <pod-ip>

# Inspect connection tracking table
kubectl exec -n kube-system ds/cilium -- \
  cilium bpf ct list global | grep "<source-ip>:<source-port> -> <dest-ip>:<dest-port>"
```

### Flannel-Specific Debugging

```bash
# Check Flannel VXLAN interface
ip link show flannel.1
ip -d link show flannel.1  # Shows VXLAN configuration

# Check route table for pod CIDR routes
ip route | grep flannel

# Verify VXLAN forwarding database entries (ARP table for VXLAN)
bridge fdb show dev flannel.1

# Flannel subnet leases
cat /var/lib/cni/networks/cbr0/*

# Flannel network configuration
kubectl get configmap kube-flannel-cfg -n kube-flannel -o yaml

# Check that flannel annotations are set on nodes
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.metadata.annotations.flannel\.alpha\.coreos\.com/public-ip}{"\n"}{end}'
```

## Layer 3: kube-proxy and Service Routing

### Verifying kube-proxy Health

```bash
# Check kube-proxy is running on every node
kubectl get pods -n kube-system -l k8s-app=kube-proxy

# Check kube-proxy logs for errors
kubectl logs -n kube-system -l k8s-app=kube-proxy --since=1h | grep -i "error\|fail\|warn"

# Verify kube-proxy mode (iptables or ipvs)
kubectl get configmap kube-proxy -n kube-system -o yaml | grep mode

# Alternatively, check on the node
kubectl exec -n kube-system ds/kube-proxy -- /bin/sh -c \
  "kube-proxy --version && iptables -t nat -L KUBE-SERVICES 2>/dev/null | head -5 || ipvsadm -L -n 2>/dev/null | head -5"
```

### Debugging iptables Mode

```bash
# On the node (or via privileged pod with hostNetwork):

# List all KUBE-SERVICES chains (ClusterIP -> Endpoint mapping)
iptables -t nat -L KUBE-SERVICES -n --line-numbers

# Find the chain for a specific service IP
SERVICE_IP=$(kubectl get svc my-service -n production -o jsonpath='{.spec.clusterIP}')
iptables -t nat -L KUBE-SERVICES -n | grep ${SERVICE_IP}

# Follow the chain to see endpoints
iptables -t nat -L KUBE-SVC-XXXXXXXXXXXXXXXX -n  # Use hash from above

# Verify KUBE-SEP (Service EndPoint) entries exist
iptables -t nat -L | grep KUBE-SEP

# Count rules — very large counts indicate a performance problem
iptables -t nat -L | wc -l

# If rules are missing, check if kube-proxy is syncing
kubectl logs -n kube-system ds/kube-proxy | grep "sync\|update"

# Force kube-proxy to resync (by bouncing the pod)
kubectl rollout restart daemonset/kube-proxy -n kube-system
```

### Debugging IPVS Mode

```bash
# List all IPVS virtual services (one per Kubernetes Service)
kubectl exec -n kube-system ds/kube-proxy -- ipvsadm -L -n

# Check specific service
SERVICE_IP=$(kubectl get svc my-service -n production -o jsonpath='{.spec.clusterIP}')
SERVICE_PORT=$(kubectl get svc my-service -n production -o jsonpath='{.spec.ports[0].port}')
kubectl exec -n kube-system ds/kube-proxy -- \
  ipvsadm -L -n | grep -A5 "${SERVICE_IP}:${SERVICE_PORT}"

# Check connection statistics
kubectl exec -n kube-system ds/kube-proxy -- \
  ipvsadm -L -n --stats | grep "${SERVICE_IP}"

# Verify the IPVS kernel module is loaded
lsmod | grep -E "ip_vs|nf_conntrack"

# Check the kube-ipvs0 virtual interface
ip addr show kube-ipvs0 | head -40  # This interface holds all ClusterIPs
```

### Service Endpoint Debugging

```bash
# The Endpoints object is the source of truth for what kube-proxy programs
kubectl get endpoints my-service -n production -o yaml

# Check EndpointSlices (used in Kubernetes 1.19+)
kubectl get endpointslices -n production -l kubernetes.io/service-name=my-service -o yaml

# If endpoints are empty, check:
# 1. Pod label selector matches
kubectl get pods -n production -l app=my-app  # Must match service selector

# 2. Pod readiness
kubectl get pods -n production -l app=my-app -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

# 3. Container port name matches service targetPort
kubectl get pod <pod-name> -n production -o yaml | grep -A10 "containers:"
kubectl get svc my-service -n production -o yaml | grep -A5 "ports:"

# Test Service ClusterIP directly from inside a pod
kubectl run test-curl \
  --rm -it \
  --image=curlimages/curl \
  --restart=Never \
  -n production \
  -- curl -v http://<cluster-ip>:<port>/healthz

# Test Service DNS from inside a pod
kubectl run test-dns \
  --rm -it \
  --image=busybox \
  --restart=Never \
  -n production \
  -- wget -qO- http://my-service:8080/healthz
```

## Layer 4: CoreDNS and DNS Resolution

### DNS Resolution Debugging Flow

DNS problems in Kubernetes typically manifest as one of three symptoms:
- Kubernetes Service names not resolving (`my-service.production.svc.cluster.local`)
- External hostnames not resolving (`api.example.com`)
- Intermittent resolution failures under load

The correct first step is to isolate which of these is failing using `dig` from inside a pod:

```bash
# Launch a debug pod with DNS tools
kubectl run dns-debug \
  --rm -it \
  --image=infoblox/dnstools \
  --restart=Never \
  -n production \
  -- bash

# Inside the pod:

# 1. Check /etc/resolv.conf — this is generated by kubelet from cluster DNS config
cat /etc/resolv.conf
# Expected output:
# nameserver 10.96.0.10        <-- CoreDNS ClusterIP
# search production.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5

# 2. Test internal Service DNS (FQDN)
dig @10.96.0.10 my-service.production.svc.cluster.local

# 3. Test internal Service DNS (short name — relies on search domain)
dig @10.96.0.10 my-service

# 4. Test external DNS forwarding
dig @10.96.0.10 api.example.com

# 5. Test DNS directly against CoreDNS pod IP (bypasses Service)
COREDNS_POD_IP=$(kubectl get pods -n kube-system -l k8s-app=kube-dns \
  -o jsonpath='{.items[0].status.podIP}')
dig @${COREDNS_POD_IP} my-service.production.svc.cluster.local

# If step 3 works but step 5 (short name) fails, the issue is ndots/search domain
# If step 3 works but step 4 fails, CoreDNS upstream forwarding is broken
# If step 3 fails, CoreDNS itself has a problem
```

### The ndots Problem

The `ndots:5` setting in `/etc/resolv.conf` means that any name with fewer than 5 dots will first be tried with each search domain appended before being tried as an absolute name. This causes unnecessary DNS queries and can create latency:

```
# Querying "api.example.com" with ndots:5 causes these queries in order:
# api.example.com.production.svc.cluster.local
# api.example.com.svc.cluster.local
# api.example.com.cluster.local
# api.example.com                          <-- finally queries the actual name
```

Fix for latency-sensitive workloads using FQDN (trailing dot):

```yaml
# Use FQDN with trailing dot to bypass ndots search
env:
- name: UPSTREAM_URL
  value: "https://api.example.com."

# Or configure dnsConfig to reduce ndots
apiVersion: v1
kind: Pod
spec:
  dnsConfig:
    options:
    - name: ndots
      value: "2"     # Reduce from 5 to 2
    - name: timeout
      value: "2"
    - name: attempts
      value: "3"
  dnsPolicy: ClusterFirst
```

### CoreDNS Health and Configuration

```bash
# Verify CoreDNS pods are running and ready
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Check CoreDNS logs for errors
kubectl logs -n kube-system -l k8s-app=kube-dns --since=30m

# Common CoreDNS error patterns:
# "i/o timeout" → CoreDNS cannot reach upstream DNS servers
# "connection refused" → Upstream DNS server is rejecting connections
# "SERVFAIL" → Query failed at authoritative server
# "plugin/errors: 2 SERVFAIL" → General CoreDNS failure

# Check CoreDNS ConfigMap
kubectl get configmap coredns -n kube-system -o yaml

# Standard Corefile
cat << 'EOF'
# Typical production Corefile
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
    }
    cache 30
    loop
    reload
    loadbalance
}
EOF

# Check if CoreDNS metrics are being exported
kubectl port-forward -n kube-system service/kube-dns 9153:9153 &
curl http://localhost:9153/metrics | grep coredns_dns_requests_total
```

### CoreDNS Upstream Forwarding Issues

```bash
# From a CoreDNS pod, test connectivity to upstream DNS
kubectl exec -n kube-system \
  $(kubectl get pods -n kube-system -l k8s-app=kube-dns -o name | head -1) \
  -- nslookup api.example.com 8.8.8.8

# Check if CoreDNS can reach the upstream nameservers from /etc/resolv.conf on the node
# Get the node where CoreDNS is running
COREDNS_NODE=$(kubectl get pods -n kube-system -l k8s-app=kube-dns \
  -o jsonpath='{.items[0].spec.nodeName}')

# From that node, test DNS connectivity
# Upstream nameservers come from the node's /etc/resolv.conf
cat /etc/resolv.conf

# If upstream DNS is unreachable, override in CoreDNS ConfigMap
# Replace "forward . /etc/resolv.conf" with:
# forward . 8.8.8.8 8.8.4.4 {
#     max_concurrent 1000
# }

# For split-horizon DNS (internal domain via internal DNS, external via public)
cat << 'EOF'
# Updated Corefile with split-horizon
.:53 {
    errors
    health
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
    }
    # Route internal.example.com to internal DNS server
    forward internal.example.com 10.0.0.53 {
        prefer_udp
    }
    # Everything else to public DNS
    forward . 8.8.8.8 8.8.4.4 {
        max_concurrent 1000
    }
    prometheus :9153
    cache 30
    loop
    reload
    loadbalance
}
EOF
kubectl edit configmap coredns -n kube-system
```

### CoreDNS Performance Issues

Under load, CoreDNS can become a bottleneck. Signs include high DNS query latency, `SERVFAIL` responses, or increased `ndots` lookup failures:

```bash
# Check CoreDNS request rate and latency
kubectl port-forward -n kube-system service/kube-dns 9153:9153 &
curl -s http://localhost:9153/metrics | grep -E "coredns_dns_request_duration|coredns_dns_requests_total"

# Scale CoreDNS horizontally
kubectl scale deployment coredns -n kube-system --replicas=4

# Alternatively, configure NodeLocal DNSCache for high-throughput clusters
# NodeLocal DNSCache runs a DNS cache on each node, reducing CoreDNS load
kubectl apply -f https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml
```

## Layer 5: Pod-to-Pod Connectivity Debugging

### Same-Node Pod Connectivity

```bash
# Get two pods on the same node
NODE="worker-01"
PODS=$(kubectl get pods -n production \
  --field-selector spec.nodeName=${NODE} \
  -o jsonpath='{.items[*].metadata.name}')

# Get their IPs
kubectl get pods -n production \
  --field-selector spec.nodeName=${NODE} \
  -o wide

# From pod-A, try to reach pod-B directly
kubectl exec -n production pod-a -- \
  curl -v http://<pod-b-ip>:8080/healthz

# Check the bridge/veth interface setup on the node
ip link show | grep -E "veth|cni|calico"
bridge link show

# Check ARP table — if pod-B's IP is missing, there's a CNI issue
ip neigh show | grep <pod-b-ip>
```

### Cross-Node Pod Connectivity

```bash
# This is the most common failure mode for CNI overlay issues
# Get pods on different nodes
kubectl get pods -n production -o wide

# From pod-A (node worker-01), ping pod-B (node worker-02)
kubectl exec -n production pod-a -- ping -c 4 <pod-b-ip>

# If ping fails, use traceroute to see where packets drop
kubectl exec -n production pod-a -- traceroute <pod-b-ip>

# Check the overlay encapsulation on node worker-01
# For VXLAN (Flannel, Calico VXLAN):
tcpdump -i flannel.1 -nn host <pod-b-node-ip>
# or
tcpdump -i any -nn udp port 8472  # Flannel
tcpdump -i any -nn udp port 4789  # VXLAN standard

# For Calico BGP (no overlay, native routing):
ip route | grep <pod-b-cidr>
# Expected: 10.244.2.0/24 via <worker-02-ip> dev eth0 proto bird

# For Cilium:
kubectl exec -n kube-system ds/cilium -- cilium monitor --type trace
```

### NetworkPolicy Debugging

NetworkPolicy is a frequent cause of mysterious connectivity failures. The key challenge is that NetworkPolicy denies are silent — there is no log entry by default:

```bash
# List all NetworkPolicies in a namespace
kubectl get networkpolicies -n production -o wide

# Describe a specific policy to understand its intent
kubectl describe networkpolicy my-policy -n production

# Check if a policy is selecting the intended pods
POLICY_POD_SELECTOR=$(kubectl get networkpolicy my-policy -n production \
  -o jsonpath='{.spec.podSelector}')
echo "Policy selects pods: ${POLICY_POD_SELECTOR}"
kubectl get pods -n production -l app=my-app  # Does this match?

# Common NetworkPolicy mistakes:
# 1. Empty podSelector {} selects ALL pods in namespace — often unintended
# 2. Ingress rules without matching egress rules (and vice versa)
# 3. Forgetting to allow DNS (UDP 53 to kube-dns)
# 4. Namespace selector not matching namespace labels

# Check namespace labels (required for cross-namespace NetworkPolicy)
kubectl get ns production -o yaml | grep -A10 labels

# Test connectivity with Cilium policy tracing
kubectl exec -n kube-system ds/cilium -- \
  cilium policy trace \
  --src-k8s-pod production:pod-a \
  --dst-k8s-pod production:pod-b \
  --dport 8080/tcp

# For Calico, check Felix stats for dropped packets
kubectl exec -n calico-system ds/calico-node -c calico-node -- \
  calico-node -felix-live 2>/dev/null | grep drop

# Enable NetworkPolicy logging in Calico (adds iptables LOG target)
kubectl edit globalnetworkpolicies.projectcalico.org default-deny
# Add: doNotTrack: false, preDNAT: false, applyOnForward: false
```

### Minimal NetworkPolicy for Common Patterns

```yaml
# Allow all traffic within a namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector: {}
  egress:
  - to:
    - podSelector: {}
  # Always allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
---
# Allow specific cross-namespace traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-scrape
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: my-api
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app: prometheus
    ports:
    - port: 9090
      protocol: TCP
```

## Ingress Troubleshooting

### Nginx Ingress Debugging

```bash
# Check Ingress controller pod health
kubectl get pods -n ingress-nginx

# View Nginx Ingress controller logs
kubectl logs -n ingress-nginx \
  deployment/ingress-nginx-controller \
  --since=30m | grep -i "error\|warn\|upstream"

# Check the generated nginx.conf to verify routes are programmed
kubectl exec -n ingress-nginx \
  deployment/ingress-nginx-controller \
  -- nginx -T 2>/dev/null | grep -A20 "upstream production_my-service"

# Verify Ingress resource is configured correctly
kubectl describe ingress my-ingress -n production

# Common Ingress issues:
# 1. TLS secret not found or in wrong namespace
kubectl get secret my-tls-secret -n production
kubectl describe secret my-tls-secret -n production

# 2. Service or port name mismatch
kubectl get ingress my-ingress -n production -o yaml | grep -A10 "backend"
kubectl get svc my-service -n production -o yaml | grep -A10 "ports"

# 3. IngressClass not specified or wrong class
kubectl get ingressclass
kubectl get ingress my-ingress -n production -o jsonpath='{.spec.ingressClassName}'

# Test routing through the Ingress controller directly
INGRESS_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -v -H "Host: myapp.example.com" http://${INGRESS_IP}/api/healthz

# Test HTTPS with certificate verification disabled
curl -vk -H "Host: myapp.example.com" https://${INGRESS_IP}/api/healthz
```

### Checking Backend Connectivity from Ingress

The Ingress controller makes requests to backend Services as a proxy. Verify the controller can reach the backend:

```bash
# From inside the Nginx Ingress controller pod
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  curl -v http://my-service.production.svc.cluster.local:8080/healthz

# Check upstream configuration in nginx
kubectl exec -n ingress-nginx deployment/ingress-nginx-controller -- \
  cat /etc/nginx/nginx.conf | grep -B5 -A20 "upstream"

# Enable debug logging in Nginx Ingress
kubectl edit configmap ingress-nginx-controller -n ingress-nginx
# Add: error-log-level: "debug"
```

## Packet Capture Techniques

### Using tcpdump in Pods

```bash
# Run tcpdump in a debug container alongside a running pod
kubectl debug -it <pod-name> \
  -n production \
  --image=nicolaka/netshoot \
  --target=<container-name> \
  -- tcpdump -i any -nn -s0 host <target-ip> -w /tmp/capture.pcap

# Copy the capture file out
kubectl cp production/<debug-pod-name>:/tmp/capture.pcap ./capture.pcap

# Analyze with Wireshark or tshark
tshark -r capture.pcap -T fields \
  -e frame.number \
  -e ip.src \
  -e ip.dst \
  -e tcp.flags \
  -e tcp.port \
  -e tcp.analysis.flags
```

### Node-Level Packet Capture

```bash
# Run a privileged pod on a specific node to capture traffic
kubectl run packet-capture \
  --rm -it \
  --image=nicolaka/netshoot \
  --restart=Never \
  --overrides='{
    "spec": {
      "nodeName": "worker-01",
      "hostNetwork": true,
      "containers": [{
        "name": "packet-capture",
        "image": "nicolaka/netshoot",
        "securityContext": {"privileged": true},
        "stdin": true,
        "tty": true
      }]
    }
  }' \
  -- bash

# Inside the privileged pod:

# Capture all traffic on the VXLAN interface
tcpdump -i flannel.1 -nn -s0 -w /tmp/overlay.pcap &

# Capture pod-to-pod traffic on the bridge
tcpdump -i cni0 -nn -s0 host <pod-ip> -w /tmp/pod-traffic.pcap &

# Capture ICMP to trace ping failures
tcpdump -i any -nn icmp

# Decode VXLAN encapsulated packets
tcpdump -i eth0 -nn udp port 8472 -w /tmp/vxlan.pcap
# Then analyze with: tshark -r vxlan.pcap -d udp.port==8472,vxlan
```

### Using Ephemeral Debug Containers (Kubernetes 1.23+)

```bash
# Inject a debug container into a running pod without modifying the pod spec
kubectl debug -it <pod-name> \
  -n production \
  --image=nicolaka/netshoot \
  --target=<container-name>

# The debug container shares the pod's network namespace
# All tools (tcpdump, ss, netstat, dig, curl) are available

# Capture traffic as seen by the container
tcpdump -i eth0 -nn -s0 port 8080

# Check socket state
ss -tunlp

# Test DNS from the container's perspective
dig @$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}') \
  my-service.production.svc.cluster.local
```

## Service Type-Specific Issues

### LoadBalancer Service Not Getting External IP

```bash
# Check Service status
kubectl get svc my-loadbalancer -n production

# If EXTERNAL-IP is <pending> for more than 2 minutes:
kubectl describe svc my-loadbalancer -n production
# Look for events like: "Error creating load balancer: ..."

# Cloud provider specific checks:

# AWS (EKS) — check for controller-manager logs
kubectl logs -n kube-system deployment/aws-load-balancer-controller | tail -30

# Check IAM permissions for the load balancer controller
# The service account needs ec2:DescribeSubnets, elasticloadbalancing:* etc.

# Verify subnet annotations are set correctly
kubectl get nodes -o yaml | grep -A5 "kubernetes.io/cluster"

# GCP (GKE) — check cloud controller manager
kubectl logs -n kube-system \
  $(kubectl get pods -n kube-system -l component=cloud-controller-manager \
    -o jsonpath='{.items[0].metadata.name}') | tail -30

# MetalLB (bare metal)
kubectl get ipaddresspools -n metallb-system
kubectl get l2advertisements -n metallb-system
kubectl logs -n metallb-system deployment/controller | tail -20
```

### NodePort Service Connectivity Issues

```bash
# Verify NodePort is listening on all nodes
NODE_PORT=$(kubectl get svc my-nodeport -n production \
  -o jsonpath='{.spec.ports[0].nodePort}')
NODE_IP=$(kubectl get nodes worker-01 \
  -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')

curl -v http://${NODE_IP}:${NODE_PORT}/healthz

# Check if the NodePort is open in the firewall
# AWS Security Group must allow the nodePort range (30000-32767)
# GCP: gcloud compute firewall-rules list | grep nodeport

# Verify iptables rule for NodePort
iptables -t nat -L KUBE-NODEPORTS -n | grep ${NODE_PORT}

# Test from inside the cluster (uses Service ClusterIP, not NodePort)
kubectl run test \
  --rm -it \
  --image=busybox \
  --restart=Never \
  -- wget -qO- http://my-nodeport:8080/healthz
```

## Creating a Systematic Debug Runbook

### Network Connectivity Debug Script

```bash
#!/bin/bash
# k8s-network-debug.sh — run this script when investigating network issues

set -euo pipefail

SOURCE_NS="${1:-production}"
SOURCE_POD="${2:-}"
DEST_NS="${3:-production}"
DEST_SVC="${4:-}"

echo "=== Kubernetes Network Diagnostic Report ==="
echo "Source: ${SOURCE_NS}/${SOURCE_POD}"
echo "Destination: ${DEST_NS}/${DEST_SVC}"
echo ""

echo "=== 1. Node Status ==="
kubectl get nodes -o wide

echo ""
echo "=== 2. CoreDNS Status ==="
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide

echo ""
echo "=== 3. CNI Plugin Status ==="
# Auto-detect CNI
if kubectl get pods -n calico-system &>/dev/null; then
  kubectl get pods -n calico-system -o wide
elif kubectl get pods -n kube-system -l k8s-app=cilium &>/dev/null; then
  kubectl get pods -n kube-system -l k8s-app=cilium -o wide
elif kubectl get pods -n kube-flannel &>/dev/null; then
  kubectl get pods -n kube-flannel -o wide
fi

echo ""
echo "=== 4. Source Pod Status ==="
if [ -n "${SOURCE_POD}" ]; then
  kubectl get pod "${SOURCE_POD}" -n "${SOURCE_NS}" -o wide
  kubectl describe pod "${SOURCE_POD}" -n "${SOURCE_NS}" | grep -A10 "Events:"
fi

echo ""
echo "=== 5. Destination Service ==="
if [ -n "${DEST_SVC}" ]; then
  kubectl get svc "${DEST_SVC}" -n "${DEST_NS}" -o wide
  kubectl get endpoints "${DEST_SVC}" -n "${DEST_NS}" -o yaml
fi

echo ""
echo "=== 6. NetworkPolicies in ${DEST_NS} ==="
kubectl get networkpolicies -n "${DEST_NS}" -o wide

echo ""
echo "=== 7. DNS Resolution Test ==="
kubectl run dns-test \
  --rm \
  --image=busybox \
  --restart=Never \
  -n "${SOURCE_NS}" \
  --command -- nslookup "${DEST_SVC}.${DEST_NS}.svc.cluster.local" 2>/dev/null || \
  echo "DNS test failed — check CoreDNS"

echo ""
echo "=== Diagnostic complete ==="
```

## Conclusion

Kubernetes network troubleshooting follows a consistent pattern regardless of the specific failure: start at the physical/virtual network layer and work up through CNI, kube-proxy, CoreDNS, and finally the application. The tools covered in this guide — from `tcpdump` and `iptables` inspection to Cilium's policy tracing and CoreDNS metric analysis — provide visibility into each layer independently.

The most important habit is to avoid jumping to conclusions based on symptoms. A pod that cannot resolve external DNS might have a broken upstream forwarder in CoreDNS, a NetworkPolicy blocking UDP 53, a kube-proxy iptables synchronization failure, or a node network firewall dropping DNS traffic. Each possibility requires a different fix, and only systematic layer-by-layer elimination identifies the correct root cause efficiently.
