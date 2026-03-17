---
title: "Kubernetes Cluster DNS: CoreDNS Advanced Configuration and Troubleshooting"
date: 2029-05-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CoreDNS", "DNS", "Networking", "NodeLocal DNSCache", "DNSSEC", "Troubleshooting"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into CoreDNS plugin chain configuration, custom forwarding rules, DNSSEC validation, NodeLocal DNSCache deployment, DNS performance tuning, and systematic troubleshooting with dnsutils in production Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-cluster-dns-coredns-advanced-configuration-troubleshooting/"
---

DNS is the invisible backbone of every Kubernetes cluster. When it works, nobody thinks about it. When it breaks, everything breaks. CoreDNS replaced kube-dns as the default cluster DNS server in Kubernetes 1.13, and its plugin-based architecture makes it far more flexible — but also more complex to operate at scale. This post covers the full operational depth: plugin chain mechanics, custom forwarding, DNSSEC, NodeLocal DNSCache, performance tuning under load, and the diagnostic workflows that actually find problems fast.

<!--more-->

# Kubernetes Cluster DNS: CoreDNS Advanced Configuration and Troubleshooting

## Section 1: CoreDNS Architecture and the Plugin Chain

CoreDNS processes DNS queries through an ordered chain of plugins defined in the Corefile. Each plugin either handles the request fully, passes it to the next plugin, or returns an error. Understanding this chain is essential before making any configuration changes.

### Default Kubernetes Corefile

```
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
```

The execution order for a query hitting the `kubernetes` plugin:

1. `errors` — logs errors to stderr
2. `health` — serves /health endpoint (not in query path)
3. `ready` — serves /ready endpoint
4. `kubernetes` — handles `cluster.local`, `in-addr.arpa`, `ip6.arpa`
5. `prometheus` — metrics collection
6. `forward` — upstream forwarding for non-cluster queries
7. `cache` — caches responses
8. `loop` — detects forwarding loops
9. `reload` — hot-reloads Corefile on change
10. `loadbalance` — round-robin A/AAAA record rotation

### Plugin Chain Deep Dive

The `kubernetes` plugin is the core of cluster DNS. It watches the Kubernetes API for Services and Endpoints and answers queries in real time without caching at the plugin level (caching is handled by the `cache` plugin).

Key `kubernetes` plugin options:

```
kubernetes cluster.local in-addr.arpa ip6.arpa {
    # How pod DNS records are created
    # insecure: create records for all pods
    # verified: only create records for pods with matching IP
    # disabled: no pod DNS records
    pods insecure

    # Pass reverse lookups to upstream if not found
    fallthrough in-addr.arpa ip6.arpa

    # TTL for DNS records (default 5s)
    ttl 30

    # Only serve records for these namespaces
    # namespaces default kube-system

    # Serve DNS records for pods not yet in Running state
    # endpoint_pod_names

    # Use node names instead of IPs for node records
    # noendpoints
}
```

### Viewing the Plugin Chain at Runtime

```bash
# Get the current Corefile
kubectl get configmap -n kube-system coredns -o yaml

# Check CoreDNS plugin registration order
kubectl exec -n kube-system deploy/coredns -- \
  /coredns -plugins 2>&1 | head -40

# CoreDNS version
kubectl exec -n kube-system deploy/coredns -- \
  /coredns -version
```

## Section 2: Custom Forwarding Rules and Split-Horizon DNS

Production environments almost always require custom forwarding — routing specific domains to internal resolvers while sending everything else upstream.

### Multi-Zone Corefile with Forwarding

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
        # Forward corp.example.com to on-prem DNS
        forward corp.example.com 10.100.0.10 10.100.0.11 {
            policy round_robin
            health_check 5s
            max_concurrent 100
        }
        # Forward staging.example.com to staging DNS
        forward staging.example.com 10.200.0.10 {
            health_check 10s
            expire 30s
        }
        # All other queries go to public resolvers
        forward . 1.1.1.1 8.8.8.8 {
            policy sequential
            health_check 5s
            max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
    # Dedicated server block for internal zone
    internal.corp.example.com:53 {
        errors
        file /etc/coredns/internal.zone
        prometheus :9153
        cache 60
        reload
    }
```

### Zone File for Static Records

Mount a zone file via ConfigMap for static internal records:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-zones
  namespace: kube-system
data:
  internal.zone: |
    $ORIGIN internal.corp.example.com.
    $TTL 3600
    @   IN  SOA ns1.internal.corp.example.com. admin.corp.example.com. (
                2029050901  ; Serial
                3600        ; Refresh
                900         ; Retry
                604800      ; Expire
                300 )       ; Minimum TTL
    @           IN  NS  ns1.internal.corp.example.com.
    ns1         IN  A   10.100.0.10
    vault       IN  A   10.100.1.50
    nexus       IN  A   10.100.1.51
    jenkins     IN  A   10.100.1.52
    artifactory IN  A   10.100.1.53
    db-primary  IN  A   10.100.2.100
    db-replica  IN  CNAME db-primary.internal.corp.example.com.
```

Update the CoreDNS deployment to mount the zone:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: coredns
        volumeMounts:
        - name: config-volume
          mountPath: /etc/coredns
          readOnly: true
        - name: zone-volume
          mountPath: /etc/coredns/zones
          readOnly: true
      volumes:
      - name: config-volume
        configMap:
          name: coredns
          items:
          - key: Corefile
            path: Corefile
      - name: zone-volume
        configMap:
          name: coredns-zones
```

### Conditional Forwarding with the `rewrite` Plugin

The `rewrite` plugin enables query manipulation before forwarding:

```
.:53 {
    errors
    rewrite {
        # Rewrite old domain to new domain
        name regex (.*)\.old-corp\.com\.$ {1}.corp.example.com.
        answer name (.*)\.corp\.example\.com\.$ {1}.old-corp.com.
    }
    rewrite {
        # Force CNAME resolution for specific host
        name exact legacy-api.corp.example.com new-api.corp.example.com
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . 10.100.0.10
    cache 30
    loop
    reload
    loadbalance
}
```

## Section 3: DNSSEC Configuration and Validation

DNSSEC adds cryptographic signatures to DNS responses. CoreDNS can both validate DNSSEC responses from upstream and sign zones it hosts.

### Enabling DNSSEC Validation

```
.:53 {
    errors
    dnssec {
        # Validate DNSSEC for all responses from upstream
        # Use the IANA root trust anchor
        trust_anchor . 20326 8 2 E06D44B80B8F1D39A95C0B0D7C65D08458E880409BBC683457104237C7F8EC8D
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . 1.1.1.1 {
        # Require DNSSEC from upstream
        # 1.1.1.1 supports DNSSEC validation
    }
    cache 30 {
        # Cache DNSSEC records
        denial 5000 300
        success 9984 300
    }
    loop
    reload
    loadbalance
}
```

### Signing an Internal Zone

For internal zones, generate keys and configure signing:

```bash
# Generate Zone Signing Key (ZSK)
dnssec-keygen -a RSASHA256 -b 2048 -n ZONE internal.corp.example.com

# Generate Key Signing Key (KSK)
dnssec-keygen -a RSASHA256 -b 4096 -f KSK -n ZONE internal.corp.example.com

# Sign the zone file
dnssec-signzone -A -3 $(head -c 16 /dev/urandom | sha1sum | cut -b 1-16) \
    -N INCREMENT -o internal.corp.example.com \
    -t internal.zone
```

CoreDNS signed zone configuration:

```
internal.corp.example.com:53 {
    errors
    dnssec {
        key file /etc/coredns/keys/Kinternal.corp.example.com.+008+12345
    }
    file /etc/coredns/zones/internal.zone.signed
    cache 60
    reload
}
```

## Section 4: NodeLocal DNSCache

NodeLocal DNSCache runs a DNS caching agent on each node as a DaemonSet. Pods query their node's local cache instead of CoreDNS pods, dramatically reducing latency and CoreDNS load.

### Architecture

```
Pod → node-local-dns:169.254.20.10 → CoreDNS (cache miss only)
                    ↓ (cached)
              immediate response
```

The node-local-dns agent listens on the link-local address `169.254.20.10` and the cluster DNS IP for the `cluster.local` domain, handling cache hits locally and forwarding misses to CoreDNS.

### Deployment

```bash
# Download the NodeLocal DNSCache manifest
NODELOCALDNS_VERSION="1.23.0"
curl -O https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml

# Set variables
CLUSTER_DNS_IP=$(kubectl get svc -n kube-system kube-dns -o jsonpath='{.spec.clusterIP}')
NODE_LOCAL_DNS_IP="169.254.20.10"

# Apply with substitutions
sed -i "s/__PILLAR__LOCAL__DNS__/${NODE_LOCAL_DNS_IP}/g" nodelocaldns.yaml
sed -i "s/__PILLAR__DNS__DOMAIN__/cluster.local/g" nodelocaldns.yaml
sed -i "s/__PILLAR__DNS__SERVER__/${CLUSTER_DNS_IP}/g" nodelocaldns.yaml
sed -i "s/__PILLAR__CLUSTER__DNS__/${CLUSTER_DNS_IP}/g" nodelocaldns.yaml

kubectl apply -f nodelocaldns.yaml
```

### NodeLocal DNSCache Corefile

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-local-dns
  namespace: kube-system
data:
  Corefile: |
    cluster.local:53 {
        errors
        cache {
            success 9984 30
            denial 9984 5
        }
        reload
        loop
        bind 169.254.20.10 10.96.0.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
        health 169.254.20.10:8080
        }
    in-addr.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10 10.96.0.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
        }
    ip6.arpa:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10 10.96.0.10
        forward . __PILLAR__CLUSTER__DNS__ {
            force_tcp
        }
        prometheus :9253
        }
    .:53 {
        errors
        cache 30
        reload
        loop
        bind 169.254.20.10 10.96.0.10
        forward . __PILLAR__UPSTREAM__SERVERS__
        prometheus :9253
        }
```

### Verifying NodeLocal DNSCache

```bash
# Check DaemonSet status
kubectl get daemonset -n kube-system node-local-dns

# Check that node-local-dns is listening
kubectl get nodes -o wide
# On a node:
ss -tulnp | grep 169.254.20.10

# Verify a pod uses NodeLocal DNS
kubectl run dnstest --image=busybox:1.36 --rm -it --restart=Never -- \
  cat /etc/resolv.conf
# Should show: nameserver 169.254.20.10

# Check cache hit rate
kubectl exec -n kube-system ds/node-local-dns -- \
  wget -qO- http://169.254.20.10:9253/metrics | grep coredns_cache
```

## Section 5: DNS Performance Tuning

### CoreDNS Resource Tuning

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: coredns
        resources:
          requests:
            cpu: 200m
            memory: 128Mi
          limits:
            cpu: 2000m
            memory: 512Mi
        # Increase number of goroutines per CPU
        env:
        - name: GOMAXPROCS
          value: "4"
```

### Cache Tuning

The `cache` plugin is critical for performance. Tune it based on your query patterns:

```
.:53 {
    cache 300 {
        # Max entries for successful responses
        success 10000

        # Max entries for NXDOMAIN/NODATA responses
        denial 5000

        # Don't cache responses with these return codes
        # servfail: don't cache server failures
        # refuse: don't cache refused queries
        # nosoa: don't cache responses missing SOA
    }
}
```

### Forward Plugin Tuning

```
forward . 1.1.1.1 8.8.8.8 8.8.4.4 {
    # Maximum simultaneous queries per upstream
    max_concurrent 1000

    # How often to health check upstreams
    health_check 5s

    # How long to keep a connection idle
    expire 10s

    # Prefer TCP for large responses
    prefer_udp

    # Policy: random, round_robin, sequential
    policy round_robin
}
```

### Horizontal Pod Autoscaling for CoreDNS

```yaml
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
  - type: Pods
    pods:
      metric:
        name: coredns_dns_requests_total
      target:
        type: AverageValue
        averageValue: 10000
```

### Cluster Proportional Autoscaler

The cluster-proportional-autoscaler scales CoreDNS based on node count:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dns-autoscaler
  namespace: kube-system
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: autoscaler
        image: registry.k8s.io/cpa/cluster-proportional-autoscaler:1.8.8
        command:
        - /cluster-proportional-autoscaler
        - --namespace=kube-system
        - --configmap=dns-autoscaler
        - --target=Deployment/coredns
        - --logtostderr=true
        - --v=2
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: dns-autoscaler
  namespace: kube-system
data:
  linear: |-
    {
      "coresPerReplica": 256,
      "nodesPerReplica": 16,
      "min": 2,
      "max": 20,
      "preventSinglePointOfFailure": true
    }
```

## Section 6: Troubleshooting with dnsutils

### Setting Up the dnsutils Pod

```bash
# One-time debugging pod
kubectl run dnsutils \
  --image=registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3 \
  --restart=Never \
  -it --rm \
  -- /bin/bash

# Or a persistent debugging pod
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: dnsutils
  namespace: default
spec:
  containers:
  - name: dnsutils
    image: registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3
    command:
    - sleep
    - "infinity"
    imagePullPolicy: IfNotPresent
  restartPolicy: Always
EOF
```

### Basic DNS Lookups

```bash
# Test cluster DNS resolution
kubectl exec dnsutils -- nslookup kubernetes.default
# Expected:
# Server:         10.96.0.10
# Address:        10.96.0.10#53
# Name:    kubernetes.default.svc.cluster.local
# Address: 10.96.0.1

# Headless service lookup (returns pod IPs)
kubectl exec dnsutils -- nslookup my-headless-svc.default

# Pod DNS lookup (requires pods: insecure or verified)
kubectl exec dnsutils -- nslookup 10-244-1-25.default.pod.cluster.local

# Cross-namespace lookup
kubectl exec dnsutils -- nslookup prometheus.monitoring.svc.cluster.local

# StatefulSet pod lookup
kubectl exec dnsutils -- nslookup web-0.web.default.svc.cluster.local

# External DNS lookup via forwarding
kubectl exec dnsutils -- nslookup github.com
```

### Advanced dig Diagnostics

```bash
# Full DNS response with all flags
kubectl exec dnsutils -- dig +noall +answer +stats kubernetes.default.svc.cluster.local

# Check DNS search domains
kubectl exec dnsutils -- dig +search kubernetes

# Check DNSSEC validation
kubectl exec dnsutils -- dig +dnssec cloudflare.com A

# Query a specific server
kubectl exec dnsutils -- dig @10.96.0.10 kubernetes.default.svc.cluster.local

# Query with specific record type
kubectl exec dnsutils -- dig @10.96.0.10 SRV _https._tcp.kubernetes.default.svc.cluster.local

# Trace the full resolution path
kubectl exec dnsutils -- dig +trace github.com

# Check PTR record for pod IP
kubectl exec dnsutils -- dig -x 10.244.1.25

# Timing and retry behavior
kubectl exec dnsutils -- dig +tries=3 +timeout=2 kubernetes.default.svc.cluster.local
```

### Checking /etc/resolv.conf in Pods

```bash
# Check a specific pod's DNS config
kubectl exec -n production my-app-pod-abc123 -- cat /etc/resolv.conf
# Expected output:
# search default.svc.cluster.local svc.cluster.local cluster.local
# nameserver 10.96.0.10
# options ndots:5

# With NodeLocal DNSCache:
# nameserver 169.254.20.10
```

The `ndots:5` setting means any query with fewer than 5 dots will try all search domains before doing an absolute lookup. This causes extra DNS queries for external domains.

### Diagnosing ndots:5 Overhead

```bash
# Count DNS queries for an external lookup without ndots
kubectl exec dnsutils -- strace -e trace=network dig github.com 2>&1 | grep -c sendto
# With ndots:5, expect 6+ queries:
# github.com.default.svc.cluster.local
# github.com.svc.cluster.local
# github.com.cluster.local
# github.com (absolute)

# Mitigate by appending a dot (absolute query)
kubectl exec dnsutils -- dig github.com.
```

Override `ndots` for specific pods:

```yaml
spec:
  dnsConfig:
    options:
    - name: ndots
      value: "2"
  dnsPolicy: ClusterFirst
```

### CoreDNS Log Analysis

Enable query logging for debugging:

```
.:53 {
    errors
    log {
        # Log all queries
        # class all
        # Or just denials
        class denial error
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . 1.1.1.1
    cache 30
    loop
    reload
    loadbalance
}
```

```bash
# Watch CoreDNS logs for a specific query pattern
kubectl logs -n kube-system -l k8s-app=kube-dns -f | grep "NXDOMAIN\|SERVFAIL"

# Count NXDOMAIN by name
kubectl logs -n kube-system -l k8s-app=kube-dns --since=1h | \
  grep "NXDOMAIN" | awk '{print $8}' | sort | uniq -c | sort -rn | head -20

# Find slow queries
kubectl logs -n kube-system -l k8s-app=kube-dns --since=1h | \
  awk '/\[INFO\]/ {
    # Parse query time if available
    print
  }'
```

### CoreDNS Prometheus Metrics

```bash
# Port-forward to CoreDNS metrics
kubectl port-forward -n kube-system svc/kube-dns 9153:9153

# Key metrics
curl -s http://localhost:9153/metrics | grep -E \
  "coredns_dns_requests_total|coredns_dns_responses_total|coredns_forward_requests_total|coredns_cache_hits_total|coredns_cache_misses_total"
```

Useful PromQL queries:

```promql
# Request rate by type
rate(coredns_dns_requests_total[5m])

# NXDOMAIN rate
rate(coredns_dns_responses_total{rcode="NXDOMAIN"}[5m])

# Cache hit ratio
rate(coredns_cache_hits_total[5m]) /
(rate(coredns_cache_hits_total[5m]) + rate(coredns_cache_misses_total[5m]))

# Forward request latency
histogram_quantile(0.99, rate(coredns_forward_request_duration_seconds_bucket[5m]))

# Panics (should be 0)
coredns_panics_total
```

### Common Issues and Fixes

**SERVFAIL on cluster.local lookups:**
```bash
# Check if CoreDNS can reach the API server
kubectl exec -n kube-system deploy/coredns -- \
  wget -qO- --ca-certificate /var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  https://kubernetes.default.svc.cluster.local/healthz

# Check CoreDNS RBAC
kubectl auth can-i list services --as=system:serviceaccount:kube-system:coredns
kubectl auth can-i list endpoints --as=system:serviceaccount:kube-system:coredns
```

**DNS loop detected:**
```bash
# CoreDNS loop plugin writes to logs
kubectl logs -n kube-system -l k8s-app=kube-dns | grep -i loop

# Check /etc/resolv.conf on nodes
# If nodelocal DNS is not running and /etc/resolv.conf points to CoreDNS IP,
# a loop can form. Fix by explicitly setting upstream forwarders.
```

**High DNS latency:**
```bash
# Check if NodeLocal DNSCache is deployed and healthy
kubectl get daemonset -n kube-system node-local-dns
kubectl get pods -n kube-system -l k8s-app=node-local-dns

# Test latency from pod
kubectl exec dnsutils -- time nslookup kubernetes.default

# Check CoreDNS CPU throttling
kubectl top pods -n kube-system -l k8s-app=kube-dns

# Check if CoreDNS is hitting resource limits
kubectl describe pods -n kube-system -l k8s-app=kube-dns | grep -A5 Limits
```

**Pods can't resolve external names:**
```bash
# Test from the pod
kubectl exec dnsutils -- nslookup github.com

# Check if CoreDNS forward plugin is reaching upstream
kubectl exec -n kube-system deploy/coredns -- \
  wget -qO /dev/null http://1.1.1.1 --timeout=3 2>&1

# Check node-level DNS (from node)
cat /etc/resolv.conf
nslookup github.com $(cat /etc/resolv.conf | grep nameserver | awk '{print $2}' | head -1)
```

## Section 7: Advanced Patterns

### Custom DNS for Specific Namespaces

Route DNS queries from specific namespaces to different resolvers using the `namespace` selector:

```
.:53 {
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        # Only serve these namespaces
        namespaces default kube-system monitoring production
    }
    forward . 1.1.1.1
    cache 30
    loop
    reload
    loadbalance
}
```

### DNS-Based Service Mesh Discovery

For Istio/Linkerd service meshes, configure CoreDNS to forward `.svc.cluster.local` to the mesh DNS:

```
.:53 {
    errors
    # Istio-specific configuration
    rewrite {
        name suffix .svc.cluster.local .svc.cluster.local
    }
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . 1.1.1.1
    cache 30
    loop
    reload
    loadbalance
}
```

### etcd-Based Dynamic DNS

```
example.com:53 {
    errors
    etcd example.com {
        stubzones
        path /skydns
        endpoint http://etcd-cluster:2379
        upstream /etc/resolv.conf
    }
    cache 300
    loadbalance
}
```

### Health Check and Readiness

```bash
# Check CoreDNS health
kubectl exec -n kube-system deploy/coredns -- \
  wget -qO- http://localhost:8080/health
# Returns: OK

# Check CoreDNS readiness
kubectl exec -n kube-system deploy/coredns -- \
  wget -qO- http://localhost:8181/ready
# Returns: OK

# Full status check script
#!/bin/bash
COREDNS_PODS=$(kubectl get pods -n kube-system -l k8s-app=kube-dns \
  -o jsonpath='{.items[*].metadata.name}')

for pod in $COREDNS_PODS; do
  echo "=== $pod ==="
  kubectl exec -n kube-system "$pod" -- wget -qO- http://localhost:8080/health
  kubectl exec -n kube-system "$pod" -- \
    wget -qO- http://localhost:9153/metrics | \
    grep "coredns_build_info"
done
```

## Section 8: Production Corefile Template

A complete, production-ready Corefile combining all best practices:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
  annotations:
    # Trigger rolling restart when changed (handled by reload plugin)
data:
  Corefile: |
    .:53 {
        errors
        health {
            lameduck 5s
        }
        ready
        log {
            class denial error
        }
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153
        # Internal domains
        forward corp.internal 10.100.0.10 10.100.0.11 {
            policy round_robin
            health_check 5s
            max_concurrent 200
            expire 30s
        }
        # External
        forward . 1.1.1.1 8.8.8.8 {
            policy round_robin
            health_check 5s
            max_concurrent 1000
            prefer_udp
        }
        cache 300 {
            success 10000
            denial 5000
        }
        loop
        reload
        loadbalance round_robin
    }
```

DNS is foundational infrastructure. Investing in CoreDNS configuration, NodeLocal DNSCache deployment, and solid monitoring pays dividends across every service in the cluster. The troubleshooting patterns here cover the vast majority of real-world DNS issues encountered in production Kubernetes environments.
