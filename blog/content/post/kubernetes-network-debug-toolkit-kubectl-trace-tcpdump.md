---
title: "Kubernetes Network Debug Toolkit: kubectl-trace, tcpdump in Pods, and Network Troubleshooting"
date: 2030-04-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "tcpdump", "kubectl-trace", "eBPF", "Troubleshooting", "Production"]
categories: ["Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade Kubernetes network debugging using ephemeral containers for tcpdump, kubectl-trace for eBPF tracing, network policy troubleshooting, and curl/netcat in distroless containers."
more_link: "yes"
url: "/kubernetes-network-debug-toolkit-kubectl-trace-tcpdump/"
---

Network problems in Kubernetes are notoriously difficult to debug. Traffic traverses multiple layers: the container network interface, the host network namespace, iptables/nftables rules, kube-proxy, the CNI plugin, and potentially a service mesh. When packets disappear, the cause could be at any layer. The default Kubernetes tooling is sparse: most production containers are distroless images with no shell, no tcpdump, and no curl. This guide covers how to bring real network debugging capabilities into a production Kubernetes cluster without compromising the security posture of running workloads.

<!--more-->

## The Production Network Debugging Stack

Before diving into specific tools, it helps to understand what a complete network debugging workflow looks like. The key insight is that in Kubernetes, you can debug network issues at multiple levels independently:

```
Layer 7: HTTP/gRPC tracing     -> kubectl-trace (BPF uprobe on http parsers)
Layer 4: TCP connection state  -> ss, conntrack, kubectl-trace
Layer 3: IP packet flow        -> tcpdump, iptables LOG rules
CNI Plugin: overlay/underlay   -> cni-specific tools (cilium monitor, calico diag)
Service Mesh: mTLS / envoy     -> istioctl, linkerd diagnostics
```

Each layer requires a different tool, and none of those tools exist in a distroless production container. The solution is ephemeral containers.

## Ephemeral Containers for Live Debugging

Ephemeral containers were promoted to stable in Kubernetes 1.25. They allow you to inject a debugging sidecar into a running pod without restarting it. The ephemeral container shares the pod's network namespace, which is exactly what you need for network debugging.

### Running tcpdump as an Ephemeral Container

```bash
# Basic tcpdump injection into a running pod
kubectl debug -it <pod-name> \
    --image=nicolaka/netshoot:latest \
    --target=<container-name> \
    -- tcpdump -i any -n -s 0 port 8080

# More targeted: capture HTTP traffic and write to a file for offline analysis
kubectl debug -it <pod-name> \
    --image=nicolaka/netshoot:latest \
    --target=<container-name> \
    -- tcpdump -i any -n -s 0 -w /proc/1/fd/1 port 8080 2>/dev/null | \
    wireshark -k -i -

# Capture DNS traffic to debug resolution issues
kubectl debug -it <pod-name> \
    --image=nicolaka/netshoot:latest \
    -- tcpdump -i any -n port 53 -v

# Capture and decode HTTP/1.1 request/response bodies
kubectl debug -it <pod-name> \
    --image=nicolaka/netshoot:latest \
    -- tcpdump -i any -A -s 0 'tcp port 80 and (((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2)) != 0)'
```

### The netshoot Container

`nicolaka/netshoot` is the de-facto standard debugging image for Kubernetes networking. It includes:

```bash
# Tools available in netshoot
tcpdump iperf3 curl wget nc ncat nmap
dig host nslookup
ss netstat traceroute mtr
iptables ip route ip addr
conntrack strace
tshark termshark

# Check what's installed
kubectl run netshoot-check --image=nicolaka/netshoot:latest \
    --restart=Never --rm -it -- bash -c "ls /usr/bin/net* /usr/sbin/tc*"
```

### Ephemeral Container for Distroless Pods

```bash
# The target pod runs a distroless image - no shell, no tools
# Inspect current pod state
kubectl get pod my-api-pod -o jsonpath='{.spec.containers[*].image}'
# gcr.io/distroless/base-debian12:nonroot

# Inject ephemeral container sharing the network namespace
kubectl debug -it my-api-pod \
    --image=nicolaka/netshoot:latest \
    --share-processes \
    -- bash

# Inside the ephemeral container, the network is shared
# You can see the same interfaces as the target container
ip addr show
ss -tlnp
netstat -tulpn

# Capture traffic on the shared network namespace
tcpdump -i eth0 -n -s 0 -v

# Exit when done - pod continues running normally
exit
```

### Writing a Structured tcpdump One-Liner for CI/CD

```bash
#!/usr/bin/env bash
# network-capture.sh - Capture network traffic from a pod for offline analysis

set -euo pipefail

POD_NAME="${1:?Usage: $0 <pod-name> <namespace> <duration_seconds>}"
NAMESPACE="${2:-default}"
DURATION="${3:-30}"
OUTPUT_FILE="capture_${POD_NAME}_$(date +%Y%m%d_%H%M%S).pcap"

echo "Capturing traffic from pod ${POD_NAME} in namespace ${NAMESPACE} for ${DURATION}s"

# Launch ephemeral container, run timed capture
kubectl debug "${POD_NAME}" \
    --namespace="${NAMESPACE}" \
    --image=nicolaka/netshoot:latest \
    --target="${POD_NAME}" \
    -- bash -c "tcpdump -i any -n -s 0 -w - 2>/dev/null" > "${OUTPUT_FILE}" &

CAPTURE_PID=$!
sleep "${DURATION}"
kill ${CAPTURE_PID} 2>/dev/null || true
wait ${CAPTURE_PID} 2>/dev/null || true

echo "Capture saved to ${OUTPUT_FILE}"
echo "Analyze with: wireshark ${OUTPUT_FILE}"
echo "Or: tcpdump -r ${OUTPUT_FILE} -n -v"
```

## kubectl-trace for eBPF Network Tracing

`kubectl-trace` is a kubectl plugin that schedules BPF programs on Kubernetes nodes using `bpftrace`. Unlike tcpdump which operates at the packet level, BPF tracing can instrument kernel functions directly, giving you visibility into TCP state machines, socket buffer pressure, and system call latencies.

### Installing kubectl-trace

```bash
# Install via krew
kubectl krew install trace

# Or install the binary directly
KTRACE_VERSION=$(curl -s https://api.github.com/repos/iovisor/kubectl-trace/releases/latest \
    | grep tag_name | cut -d'"' -f4)

curl -L "https://github.com/iovisor/kubectl-trace/releases/download/${KTRACE_VERSION}/kubectl-trace_linux_amd64.tar.gz" \
    | tar -xzf - kubectl-trace

sudo mv kubectl-trace /usr/local/bin/
kubectl trace --help
```

### Tracing TCP Connections

```bash
# Trace all new TCP connections on a node
kubectl trace run <node-name> -e '
tracepoint:syscalls:sys_enter_connect
{
    $task = (struct task_struct *)curtask;
    printf("PID: %d COMM: %s\n", pid, comm);
}
'

# Trace TCP retransmits - critical for diagnosing packet loss
kubectl trace run <node-name> -e '
kprobe:tcp_retransmit_skb
{
    $sk  = (struct sock *)arg0;
    $skc = (struct sock_common *)$sk;
    printf("Retransmit: sport=%d dport=%d\n",
           $skc->skc_num,
           bswap16($skc->skc_dport));
}
'

# Trace DNS query latency
kubectl trace run <node-name> -e '
kprobe:udp_sendmsg
/comm == "coredns"/
{
    @ts[tid] = nsecs;
}
kretprobe:udp_recvmsg
/@ts[tid]/
{
    @latency_us = hist((nsecs - @ts[tid]) / 1000);
    delete(@ts[tid]);
}
END
{
    print(@latency_us);
}
'
```

### Tracing HTTP/2 gRPC Connections

```bash
# Trace Go HTTP/2 frames - useful for gRPC debugging
# This attaches a uprobe to the golang net/http2 frame writer
kubectl trace run <node-name> --pod <pod-name> -e '
uprobe:/proc/$(pgrep -n myapp)/exe:"net/http2.(*Framer).WriteData"
{
    printf("HTTP2 DATA frame: stream=%d len=%d\n",
           sarg0, sarg1);
}
'

# Trace TLS handshake latency in a Go binary
kubectl trace run <node-name> --pod <pod-name> -e '
uprobe:/proc/$(pgrep -n myapp)/exe:"crypto/tls.(*Conn).Handshake"
{
    @ts[tid] = nsecs;
}
uretprobe:/proc/$(pgrep -n myapp)/exe:"crypto/tls.(*Conn).Handshake"
/@ts[tid]/
{
    @handshake_ms = hist((nsecs - @ts[tid]) / 1000000);
    delete(@ts[tid]);
}
'
```

### Tracing Kernel TCP Metrics

```bash
# Comprehensive TCP health dashboard using kubectl-trace
cat << 'EOF' > tcp-health.bt
/* tcp-health.bt - run with: kubectl trace run <node> -f tcp-health.bt */

/* Track connection setup latency */
kprobe:tcp_v4_connect
{
    @conn_start[tid] = nsecs;
}

kretprobe:tcp_v4_connect
/@conn_start[tid]/
{
    @connect_us = hist((nsecs - @conn_start[tid]) / 1000);
    delete(@conn_start[tid]);
}

/* Track SYN queue depth */
kprobe:tcp_syn_flood_action
{
    @syn_flood_drop = count();
}

/* Track socket buffer full conditions */
kprobe:tcp_enter_loss
{
    printf("TCP loss: %s pid=%d\n", comm, pid);
    @loss_by_process[comm] = count();
}

/* Track connection timeouts */
kprobe:tcp_write_timeout
{
    @write_timeout[comm] = count();
}

interval:s:5
{
    printf("\n=== TCP Health (5s snapshot) ===\n");
    printf("Connect latencies:\n");
    print(@connect_us);
    printf("\nLoss events by process:\n");
    print(@loss_by_process);
    printf("\nSYN flood drops: ");
    print(@syn_flood_drop);
    clear(@loss_by_process);
    clear(@write_timeout);
}
EOF

kubectl trace run worker-node-01 -f tcp-health.bt
```

## curl and netcat in Distroless Containers

When you need to make HTTP requests or test TCP connectivity from within a pod that has no shell, use ephemeral containers or the following techniques.

### Testing Service Connectivity

```bash
# Test HTTP connectivity from within the cluster network namespace
# Without changing the target pod
kubectl run curl-test \
    --image=curlimages/curl:latest \
    --restart=Never \
    --rm -it \
    --namespace=production \
    -- curl -v http://my-service.production.svc.cluster.local:8080/health

# Test with specific headers to bypass auth
kubectl run curl-test \
    --image=curlimages/curl:latest \
    --restart=Never \
    --rm -it \
    -- curl -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
            -H "Accept: application/json" \
            -v \
            https://kubernetes.default.svc/api/v1/namespaces

# Test TCP connectivity (netcat)
kubectl run nc-test \
    --image=nicolaka/netshoot:latest \
    --restart=Never \
    --rm -it \
    -- nc -zv postgresql-service.database.svc.cluster.local 5432

# Test UDP (DNS)
kubectl run dns-test \
    --image=nicolaka/netshoot:latest \
    --restart=Never \
    --rm -it \
    -- nslookup kubernetes.default.svc.cluster.local
```

### Running Diagnostics Inside a Distroless Pod

```bash
# Inject curl into the pod's network namespace via ephemeral container
kubectl debug my-distroless-pod \
    --image=curlimages/curl:latest \
    -it \
    -- sh

# Inside the ephemeral container (shares pod network namespace)
# Test internal service
curl -v http://internal-api:8080/health

# Check which DNS server the pod uses
cat /etc/resolv.conf
# nameserver 10.96.0.10
# search default.svc.cluster.local svc.cluster.local cluster.local

# Test DNS resolution
nslookup internal-api.default.svc.cluster.local 10.96.0.10

# Test with specific timeout
curl --connect-timeout 5 --max-time 10 \
    http://internal-api:8080/health
```

### Persistent Debug Pod in Target Namespace

For extended debugging sessions, running a persistent debug pod in the same namespace saves time:

```yaml
# debug-pod.yaml - ephemeral debug pod
apiVersion: v1
kind: Pod
metadata:
  name: network-debugger
  namespace: production
  labels:
    app: network-debugger
    purpose: debugging
spec:
  containers:
  - name: debugger
    image: nicolaka/netshoot:latest
    command: ["sleep", "infinity"]
    resources:
      requests:
        memory: "64Mi"
        cpu: "100m"
      limits:
        memory: "256Mi"
        cpu: "500m"
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
  serviceAccountName: default
  restartPolicy: Never
  terminationGracePeriodSeconds: 0
```

```bash
kubectl apply -f debug-pod.yaml

# Run diagnostics
kubectl exec -it network-debugger -n production -- bash

# Test all services in namespace
for svc in $(kubectl get svc -n production -o name); do
    name=$(echo $svc | cut -d/ -f2)
    port=$(kubectl get svc $name -n production -o jsonpath='{.spec.ports[0].port}')
    timeout 2 nc -z ${name}.production.svc.cluster.local ${port} && \
        echo "OK: ${name}:${port}" || echo "FAIL: ${name}:${port}"
done

# Clean up when done
kubectl delete pod network-debugger -n production
```

## Network Policy Troubleshooting Flow

Network policies in Kubernetes are a common source of mysterious connection failures. Here is a systematic troubleshooting workflow.

### Step 1: Identify Policy Scope

```bash
# List all network policies in the namespace
kubectl get networkpolicy -n <namespace> -o wide

# Describe a specific policy
kubectl describe networkpolicy <policy-name> -n <namespace>

# Check which pods are selected by a policy
kubectl get pods -n <namespace> -l <selector-from-policy>

# Example: policy selects pods with app=frontend
kubectl get pods -n production -l app=frontend --show-labels
```

### Step 2: Test Connectivity Methodically

```bash
#!/usr/bin/env bash
# network-policy-test.sh

NAMESPACE="${1:-default}"
SOURCE_POD="${2}"
DEST_POD="${3}"
DEST_PORT="${4:-8080}"

echo "=== Network Policy Connectivity Test ==="
echo "Namespace: ${NAMESPACE}"
echo "Source: ${SOURCE_POD}"
echo "Destination: ${DEST_POD}:${DEST_PORT}"

DEST_IP=$(kubectl get pod "${DEST_POD}" -n "${NAMESPACE}" \
    -o jsonpath='{.status.podIP}')
echo "Destination IP: ${DEST_IP}"

# Test direct pod IP
echo ""
echo "--- Testing direct pod IP ---"
kubectl exec "${SOURCE_POD}" -n "${NAMESPACE}" -- \
    sh -c "timeout 3 nc -zv ${DEST_IP} ${DEST_PORT} && echo PASS || echo FAIL"

# Test via service DNS
DEST_SVC=$(kubectl get svc -n "${NAMESPACE}" \
    -o jsonpath="{.items[?(@.spec.selector.app=='${DEST_POD}')].metadata.name}")
if [ -n "${DEST_SVC}" ]; then
    echo ""
    echo "--- Testing via service DNS ---"
    kubectl exec "${SOURCE_POD}" -n "${NAMESPACE}" -- \
        sh -c "timeout 3 nc -zv ${DEST_SVC}.${NAMESPACE}.svc.cluster.local ${DEST_PORT} && echo PASS || echo FAIL"
fi
```

### Step 3: Diagnose with Calico/Cilium Tools

#### Calico Network Policy Diagnostics

```bash
# Check Calico policy evaluation for a flow
calicoctl node diags

# Use calicoctl to show effective policies for a pod
calicoctl get workloadendpoint \
    -n production \
    <node-name>.<namespace>.<pod-name>.<interface>

# Show all policies that apply to a specific pod
calicoctl get networkpolicy -n production -o yaml

# Enable Calico logging for a specific flow
cat <<EOF | calicoctl apply -f -
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: debug-logging
  namespace: production
spec:
  selector: app == 'my-app'
  ingress:
  - action: Log
    source:
      selector: app == 'other-app'
  - action: Allow
    source:
      selector: app == 'other-app'
EOF

# Watch kernel logs for Calico drops
kubectl logs -n kube-system -l k8s-app=calico-node -f | grep -E "DROP|DENY"
```

#### Cilium Network Policy Diagnostics

```bash
# Cilium connectivity test
kubectl exec -it -n kube-system daemonset/cilium -- \
    cilium connectivity test

# Check policy enforcement for a pod
CILIUM_POD=$(kubectl get pods -n kube-system -l k8s-app=cilium \
    -o jsonpath='{.items[0].metadata.name}')

# List endpoints
kubectl exec -it "${CILIUM_POD}" -n kube-system -- cilium endpoint list

# Check policy for a specific endpoint
kubectl exec -it "${CILIUM_POD}" -n kube-system -- \
    cilium endpoint get <endpoint-id>

# Monitor live policy decisions
kubectl exec -it "${CILIUM_POD}" -n kube-system -- \
    cilium monitor --type drop

# Hubble flow observability (requires Hubble)
hubble observe --namespace production \
    --pod my-frontend \
    --verdict DROPPED \
    --follow

# Hubble for specific flow
hubble observe --from-pod production/frontend \
    --to-pod production/backend \
    --last 100
```

### Step 4: iptables Tracing

When the CNI uses iptables (kube-proxy IPTABLES mode, Calico), you can use the TRACE target to log rule evaluation:

```bash
# WARNING: iptables TRACE can be high-volume on busy nodes
# Enable tracing module
kubectl debug node/<node-name> -it --image=nicolaka/netshoot:latest -- bash

# Inside the node debug shell
chroot /host

# Load the xt_LOG module
modprobe xt_LOG

# Trace packets from a specific pod to a destination
# Get the pod's IP
POD_IP="10.244.1.42"
DEST_IP="10.244.2.15"
DEST_PORT="8080"

# Add trace rules (these go BEFORE the main rules)
iptables -t raw -A PREROUTING -s ${POD_IP} -d ${DEST_IP} \
    -p tcp --dport ${DEST_PORT} -j TRACE

iptables -t raw -A OUTPUT -s ${POD_IP} -d ${DEST_IP} \
    -p tcp --dport ${DEST_PORT} -j TRACE

# Watch the kernel log
dmesg -w | grep "TRACE:"

# Example TRACE output:
# [12345.678] TRACE: raw:PREROUTING:rule:2 IN=eth0 SRC=10.244.1.42 DST=10.244.2.15 ...
# [12345.679] TRACE: mangle:PREROUTING:rule:1 ...
# [12345.680] TRACE: nat:PREROUTING:rule:3 ...  <- DNAT happens here for Services

# Clean up trace rules when done
iptables -t raw -D PREROUTING -s ${POD_IP} -d ${DEST_IP} \
    -p tcp --dport ${DEST_PORT} -j TRACE
iptables -t raw -D OUTPUT -s ${POD_IP} -d ${DEST_IP} \
    -p tcp --dport ${DEST_PORT} -j TRACE

exit
```

## Diagnosing DNS Issues in Kubernetes

DNS is the most common source of mysterious application failures in Kubernetes. Here is a complete DNS troubleshooting workflow.

### DNS Resolution Debugging

```bash
# Check CoreDNS is healthy
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50

# Enable CoreDNS query logging
kubectl edit configmap coredns -n kube-system
# Add "log" plugin to the Corefile:
# .:53 {
#     log          <-- add this line
#     errors
#     health { lameduck 5s }
#     ...
# }
kubectl rollout restart deployment/coredns -n kube-system

# Watch DNS queries in real-time
kubectl logs -n kube-system -l k8s-app=kube-dns -f | grep -v "health"

# Test DNS from a debug pod
kubectl run dnstest --image=nicolaka/netshoot:latest \
    --restart=Never --rm -it -- bash

# Inside the debug pod:
# Check /etc/resolv.conf
cat /etc/resolv.conf

# Test each search domain
dig @10.96.0.10 my-service.default.svc.cluster.local
dig @10.96.0.10 my-service.default.svc.cluster.local A +noall +answer
dig @10.96.0.10 my-service.default.svc.cluster.local AAAA +noall +answer

# Check SRV records (for service discovery)
dig @10.96.0.10 _http._tcp.my-service.default.svc.cluster.local SRV

# Test external DNS resolution
dig @10.96.0.10 google.com

# Measure DNS latency
for i in $(seq 1 10); do
    time dig @10.96.0.10 my-service.production.svc.cluster.local +noall +answer
done
```

### ndots Configuration Impact

```bash
# The ndots setting in resolv.conf determines how many dots trigger absolute lookup
# Default: ndots:5 - this means "my-service" requires 5 search domain lookups
# before trying it as-is

# Check current ndots
cat /etc/resolv.conf | grep ndots
# options ndots:5

# Impact: "curl http://my-service:8080" causes these DNS queries:
# my-service.default.svc.cluster.local
# my-service.svc.cluster.local
# my-service.cluster.local
# my-service.<node-search-domain>
# my-service.  (absolute)

# Fix: use FQDN with trailing dot or reduce ndots in pod spec
# In pod spec:
# dnsConfig:
#   options:
#   - name: ndots
#     value: "2"

# Or use FQDN: "my-service.default.svc.cluster.local."
```

## Advanced: Packet Capture with Node-Level tcpdump

For cases where you need to capture traffic at the node level (e.g., to see the CNI encapsulation), you can debug the node directly.

```bash
# Access node network namespace
kubectl debug node/<node-name> -it \
    --image=nicolaka/netshoot:latest -- bash

# Inside the node debug shell
chroot /host

# List all network interfaces (including CNI veth pairs)
ip link show

# Capture on the node's pod-facing veth interface
# First, find the veth interface connected to the target pod
POD_IP="10.244.1.42"

# Find the interface
ip route get ${POD_IP}
# or
arp -n ${POD_IP}

# Capture on the specific veth
tcpdump -i veth12345 -n -s 0 -v

# Capture on the CNI overlay interface (e.g., flannel0, cali+ tunnel)
tcpdump -i flannel.1 -n -s 0 -v   # Flannel
tcpdump -i tunl0    -n -s 0 -v    # Calico IPIP
tcpdump -i cilium_vxlan -n -s 0 -v # Cilium VXLAN

# For multi-node debugging: capture with VXLAN decapsulation
tcpdump -i eth0 -n -s 0 port 8472 -v  # VXLAN port

exit
```

## Service Mesh Debugging

If you are running Istio or Linkerd, network issues often originate in the sidecar proxy. Here is how to debug mesh-level network problems.

```bash
# Istio debugging
# Check proxy status for all pods
istioctl proxy-status

# Check proxy configuration for a specific pod
istioctl proxy-config all my-pod.production

# Check listeners (what ports envoy is listening on)
istioctl proxy-config listeners my-pod.production

# Check clusters (what upstreams envoy knows about)
istioctl proxy-config clusters my-pod.production

# Check routes
istioctl proxy-config routes my-pod.production

# Enable access logging on a specific pod
kubectl exec my-pod -n production -c istio-proxy -- \
    curl -X POST http://localhost:15000/logging?level=debug

# Watch envoy access logs
kubectl logs my-pod -n production -c istio-proxy -f | \
    jq -r '. | select(.response_code != null) | "\(.response_code) \(.path) \(.duration)ms"'

# Linkerd debugging
linkerd diagnostics proxy-metrics --namespace production --pod my-pod
linkerd viz top --namespace production
linkerd viz tap deploy/my-deployment --namespace production
```

## Automated Network Connectivity Matrix

For systematic testing of all service-to-service connectivity in a namespace, automate the test matrix:

```bash
#!/usr/bin/env bash
# connectivity-matrix.sh - test all service-to-service connectivity

NAMESPACE="${1:-default}"

# Get all services and their ports
declare -A SERVICE_PORTS
while IFS= read -r line; do
    svc=$(echo "${line}" | awk '{print $1}')
    port=$(echo "${line}" | awk '{print $2}')
    SERVICE_PORTS["${svc}"]="${port}"
done < <(kubectl get svc -n "${NAMESPACE}" \
    -o custom-columns=NAME:.metadata.name,PORT:.spec.ports[0].port \
    --no-headers | grep -v "<none>")

echo "=== Connectivity Matrix for namespace: ${NAMESPACE} ==="
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Run connectivity test from a debug pod
kubectl run connectivity-tester \
    --image=nicolaka/netshoot:latest \
    --restart=Never \
    --namespace="${NAMESPACE}" \
    --overrides='{"spec":{"terminationGracePeriodSeconds":0}}' \
    -- sleep 300 &

sleep 5  # wait for pod to be ready

for svc in "${!SERVICE_PORTS[@]}"; do
    port="${SERVICE_PORTS[$svc]}"
    fqdn="${svc}.${NAMESPACE}.svc.cluster.local"

    # Test TCP
    result=$(kubectl exec connectivity-tester -n "${NAMESPACE}" -- \
        timeout 3 nc -zv "${fqdn}" "${port}" 2>&1)

    if echo "${result}" | grep -q "succeeded\|Connected"; then
        echo "PASS  TCP ${fqdn}:${port}"
    else
        echo "FAIL  TCP ${fqdn}:${port}"
    fi

    # Test HTTP if port looks like HTTP
    if [[ "${port}" =~ ^(80|8080|8443|443|3000|4000|5000|9090)$ ]]; then
        http_code=$(kubectl exec connectivity-tester -n "${NAMESPACE}" -- \
            curl -s -o /dev/null -w "%{http_code}" \
            --connect-timeout 3 --max-time 5 \
            "http://${fqdn}:${port}/health" 2>/dev/null || echo "000")
        echo "      HTTP ${fqdn}:${port}/health -> HTTP ${http_code}"
    fi
done

kubectl delete pod connectivity-tester -n "${NAMESPACE}" --grace-period=0
```

## Key Takeaways

Effective Kubernetes network debugging requires a layered approach. The tools that work in a local development environment do not exist in production distroless containers — but they do not need to. Ephemeral containers give you the ability to inject debugging capabilities into a live pod without restarting it or changing its image.

**Ephemeral containers** are the most versatile tool. `kubectl debug -it <pod> --image=nicolaka/netshoot:latest` gives you full network debugging access within 10 seconds without touching the workload.

**kubectl-trace** bridges the gap between packet-level tcpdump and application-level tracing by using eBPF to instrument kernel TCP functions, system calls, and even Go/Java runtime symbols without any application changes.

**Network policy troubleshooting** must be systematic: identify which policies apply, test direct pod IP first (bypasses kube-proxy), test via service DNS second, then use CNI-specific tools (cilium monitor, calicoctl) to see policy decision logs.

**DNS issues** are the most common root cause of intermittent connection failures. Always check `/etc/resolv.conf` ndots configuration and use FQDN with trailing dot for latency-sensitive service discovery.

**iptables TRACE** is the nuclear option for following a specific flow through all iptables chains on a node — invaluable when a service is unreachable and you cannot determine which rule is dropping the packets.
