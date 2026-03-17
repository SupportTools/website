---
title: "CoreDNS Advanced Configuration: Custom Zones, Split-Horizon DNS, and Performance Tuning"
date: 2028-01-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CoreDNS", "DNS", "Networking", "Performance", "Service Discovery"]
categories: ["Kubernetes", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced CoreDNS configuration guide covering Corefile zones, stub zones, forward plugins, ndots tuning, DNS caching, rewrite rules, autopath plugin, DNS-based service discovery patterns, and CoreDNS metrics with debugging."
more_link: "yes"
url: "/kubernetes-dns-coredns-advanced-guide-enterprise/"
---

CoreDNS is the default DNS server for Kubernetes clusters from version 1.13 onward, replacing kube-dns. Its plugin-based architecture allows fine-grained customization of DNS resolution behavior that kube-dns could not achieve. Understanding CoreDNS configuration is essential for resolving DNS performance issues, implementing split-horizon DNS for hybrid cloud environments, reducing DNS lookup latency in applications with high query rates, and integrating Kubernetes service discovery with external DNS infrastructure.

<!--more-->

# CoreDNS Advanced Configuration: Custom Zones, Split-Horizon DNS, and Performance Tuning

## Section 1: CoreDNS Architecture

### Plugin Chain

Every DNS query in CoreDNS flows through a plugin chain defined in the Corefile. Plugins execute in order and each can modify the query, respond directly, or pass to the next plugin.

```
Query arrives
    │
    ▼
errors plugin    → Captures and logs errors from subsequent plugins
    │
    ▼
health plugin    → Responds to /health checks (bypasses chain for health endpoint)
    │
    ▼
cache plugin     → Returns cached response if available; stores new responses
    │
    ▼
kubernetes plugin → Resolves cluster.local service/pod names
    │
    ▼
forward plugin   → Forwards unresolved queries to upstream resolvers
    │
    ▼
Response returned
```

### Default Kubernetes Corefile

```yaml
# default-corefile-configmap.yaml
# This is what Kubernetes deploys by default
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
        }
        cache 30
        loop
        reload
        loadbalance
    }
```

## Section 2: Custom Zones

### Authoritative Zone for Internal Domains

```yaml
# coredns-custom-zones.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    # ── Cluster DNS zone ─────────────────────────────────────────────────────
    .:53 {
        errors
        health {
            lameduck 5s
        }
        ready

        # Kubernetes service discovery
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }

        # Forward everything else to upstream resolvers
        forward . /etc/resolv.conf {
            max_concurrent 1000
        }

        cache 30
        loop
        reload
        loadbalance
        prometheus :9153
    }

    # ── Internal corporate domain ─────────────────────────────────────────────
    # Serve internal.example.com authoritatively from zone files
    # Use case: corporate intranet records, VPN-accessible services
    internal.example.com:53 {
        errors
        file /etc/coredns/internal.example.com.db
        cache 300  # Cache internal records for 5 minutes
        prometheus :9153
    }

    # ── Stub zone: delegate a subdomain to dedicated DNS servers ──────────────
    # All queries for corp.example.com are forwarded ONLY to these servers
    # Use case: Active Directory integration, legacy DNS infrastructure
    corp.example.com:53 {
        errors
        forward . 10.0.1.53 10.0.2.53 {
            # Use TCP for larger responses (DNSSEC, AD records)
            force_tcp
            # Health check these servers
            health_check 30s
            # Maximum parallel requests per upstream
            max_concurrent 100
            # Expire server from rotation if it fails
            expire 10s
        }
        cache 60
        prometheus :9153
    }
---
# Zone file for internal.example.com
# Mount as a volume in CoreDNS pods
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-zone-files
  namespace: kube-system
data:
  internal.example.com.db: |
    ; Zone file for internal.example.com
    $ORIGIN internal.example.com.
    $TTL 300

    @    IN SOA ns1.internal.example.com. admin.example.com. (
              2028011501 ; Serial (YYYYMMDDNN)
              3600       ; Refresh
              900        ; Retry
              604800     ; Expire
              300 )      ; Minimum TTL

    ; Name servers
    @    IN NS ns1.internal.example.com.

    ; A records for internal services
    ns1          IN A   10.0.0.10
    vpn-gateway  IN A   10.0.0.1
    bastion      IN A   10.0.0.5
    ntp          IN A   10.0.0.2

    ; Internal API gateway
    api          IN A   10.0.1.100
    api          IN A   10.0.1.101  ; Second address for round-robin

    ; Database access
    postgres-primary  IN A  10.10.0.10
    postgres-replica  IN A  10.10.0.11
    postgres-replica  IN A  10.10.0.12

    ; CNAME records
    db         IN CNAME postgres-primary.internal.example.com.
    monitoring IN CNAME grafana.production.svc.cluster.local.
```

## Section 3: Split-Horizon DNS

Split-horizon DNS serves different answers for the same domain name depending on the query source. This is critical for hybrid cloud environments where the same service has different endpoints for internal Kubernetes pods and external internet clients.

```yaml
# split-horizon-corefile.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    # ── Primary cluster zone ──────────────────────────────────────────────────
    .:53 {
        errors
        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153

        # Rewrite: resolve api.example.com to internal service endpoint
        # when queried from within the cluster
        # This implements split-horizon: internal clients get ClusterIP,
        # external clients get LoadBalancer IP via public DNS
        rewrite name api.example.com api-gateway.production.svc.cluster.local

        # Forward everything not handled above
        forward . /etc/resolv.conf {
            max_concurrent 1000
        }

        cache 30
        loop
        reload
        loadbalance
    }

    # ── api.example.com zone: split-horizon for specific domain ──────────────
    # When pods query api.example.com, CoreDNS answers with the internal
    # ClusterIP instead of forwarding to external DNS (which would return
    # the LoadBalancer IP, potentially causing extra network hops or TLS issues)
    api.example.com:53 {
        errors
        # template generates dynamic responses based on the query
        template IN A {
            # Respond with internal ClusterIP for the API gateway service
            answer "{{ .Name }} 30 IN A 10.96.50.100"
            # ClusterIP of the api-gateway service
        }
        prometheus :9153
    }
```

### Template Plugin for Dynamic Responses

```yaml
# template-plugin-examples.yaml
# The template plugin generates DNS responses from Go templates
# Use cases: wildcard responses, dynamic content based on query name

data:
  Corefile: |
    .:53 {
        errors
        # ── Wildcard Internal Service Response ────────────────────────────────
        # Respond to *.internal.svc with the internal ingress controller IP
        # Allows wildcard DNS for development/staging environment routing
        template IN A internal.svc {
            # .Name contains the queried name; strip the suffix and respond
            answer "{{ .Name }} 30 IN A 10.0.0.50"
        }

        # ── PTR record template for reverse DNS ───────────────────────────────
        # Generate PTR records for the 10.96.0.0/12 Kubernetes service CIDR
        # without maintaining individual PTR records
        template IN PTR 96.10.in-addr.arpa. {
            # Convert 10.96.x.y → y.x.96.10.in-addr.arpa → svc-10-96-x-y.svc.cluster.local
            answer "{{ .Name }} 30 IN PTR placeholder.svc.cluster.local."
        }

        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }

        forward . /etc/resolv.conf
        cache 30
        prometheus :9153
    }
```

## Section 4: Forward Plugin Configuration

```yaml
# forward-plugin-advanced.yaml
data:
  Corefile: |
    .:53 {
        errors
        health

        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }

        # ── Primary forwarding: prefer internal DNS servers ──────────────────
        forward . 10.0.0.53 10.0.1.53 8.8.8.8 8.8.4.4 {
            # Prefer first server; fall back to next if it fails
            # policy: random selects randomly (better load distribution)
            # policy: round_robin distributes in order
            # policy: sequential always tries first server first (default)
            policy random

            # Declare internal servers as preferred
            # prefer internal resolvers for latency
            # 10.0.0.53 and 10.0.1.53 are the primary servers

            # Health check interval for each upstream
            health_check 5s

            # Remove server from rotation after 3 consecutive failures
            expire 30s

            # Maximum concurrent queries per upstream server
            max_concurrent 500

            # Force TCP for large responses (DNSSEC-signed responses)
            # force_tcp

            # Timeout for each query attempt
            # Configurable via CoreDNS startup flags, not Corefile
        }

        cache 30
        prometheus :9153
        reload
    }

    # ── Per-domain forwarding with policy ────────────────────────────────────
    # Active Directory integration: forward AD domain to domain controllers
    ad.example.com:53 {
        errors
        forward . 10.1.0.10 10.1.0.11 10.1.0.12 {
            # AD DC must use TCP for large Kerberos/LDAP SRV records
            force_tcp
            health_check 10s
            expire 60s
            max_concurrent 50
        }
        cache 60
        prometheus :9153
    }
```

## Section 5: DNS Caching Optimization

### Cache Plugin Configuration

```yaml
# cache-plugin-optimization.yaml
data:
  Corefile: |
    .:53 {
        errors
        health

        # ── Cache plugin: primary performance optimization ──────────────────
        # Without caching, every DNS query hits the upstream resolver.
        # With a 300-second cache for positive responses, repeated queries
        # for stable service IPs are served in microseconds.
        cache {
            # success: TTL for successful (NOERROR) responses
            # Kubernetes service IPs are stable — cache aggressively
            success 9984 300 30
            #        ^    ^   ^
            #        |    |   Minimum TTL to honor from upstream responses
            #        |    Maximum TTL (override if upstream TTL is higher)
            #        Cache size in entries (9984 is a power-of-2 minus 32 for memory alignment)

            # denial: TTL for negative (NXDOMAIN, SERVFAIL) responses
            # Keep negative cache short: a newly created service should be discoverable quickly
            denial 9984 5 1
            #       ^    ^ ^
            #       |    | Minimum TTL for negative responses
            #       |    Maximum TTL for negative responses (5 seconds)
            #       Cache size

            # servfail: cache SERVFAIL responses briefly to prevent thundering herd
            # after upstream failure
            servfail 1 1s
        }

        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }

        forward . /etc/resolv.conf {
            max_concurrent 1000
        }

        prometheus :9153
        reload
    }
```

### Prefetch for Hot Records

```yaml
# prefetch-plugin.yaml
data:
  Corefile: |
    .:53 {
        errors
        health

        # ── Prefetch: refresh cache before TTL expiry ─────────────────────────
        # Without prefetch: every TTL expiry causes a cache miss + upstream query
        # during which the stale record is served, then a new record is fetched.
        # With prefetch: when a cached record has been hit > threshold times
        # and is within percentage of TTL expiry, prefetch in the background.
        # Eliminates cache miss spikes for hot DNS records.
        cache {
            success 9984 300 30
            denial 9984 5 1
            # Prefetch: refresh when record has >3 hits and TTL <= 10% remaining
            prefetch 3 60s 10%
        }

        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }

        forward . /etc/resolv.conf
        prometheus :9153
    }
```

## Section 6: ndots Configuration

The `ndots` resolver option is one of the most impactful DNS performance tuning knobs. It controls how many dots in a name trigger an immediate lookup vs. trying search domains first.

### The ndots Problem

```bash
# Understanding ndots behavior:
# With ndots:5 (Kubernetes default):
# Query: "redis" (0 dots < 5)
# CoreDNS lookup sequence:
#   1. redis.production.svc.cluster.local  → NXDOMAIN
#   2. redis.svc.cluster.local             → NXDOMAIN
#   3. redis.cluster.local                 → NXDOMAIN
#   4. redis.ec2.internal (or node domain) → NXDOMAIN
#   5. redis                               → NXDOMAIN or result
# 5 DNS queries for every short name!

# With the fully-qualified service name (FQDN ending in .):
# Query: "redis.production.svc.cluster.local." (5 dots — terminates immediately)
# CoreDNS lookup sequence:
#   1. redis.production.svc.cluster.local. → Answer
# 1 DNS query!
```

```yaml
# pod-dns-config.yaml
# Configure ndots at the pod level for services with high DNS query rates
apiVersion: apps/v1
kind: Deployment
metadata:
  name: high-query-rate-service
  namespace: production
spec:
  template:
    spec:
      # Pod-level DNS configuration overrides node resolv.conf
      dnsPolicy: ClusterFirst  # Use CoreDNS (default)
      dnsConfig:
        options:
          # Reduce ndots from 5 to 2 for services that use FQDNs
          # With ndots:2, names with >= 2 dots are tried as absolute first
          # redis.production.svc.cluster.local (5 dots) → direct lookup
          # redis (0 dots) → tries search domains first
          - name: ndots
            value: "2"

          # Timeout for DNS queries in seconds
          - name: timeout
            value: "5"

          # Number of retry attempts before failing
          - name: attempts
            value: "3"

          # Use all DNS servers simultaneously (avoids sequential fallback latency)
          # Available in recent glibc versions
          # - name: single-request-reopen

        # Optional: customize search domains beyond the defaults
        # Default search domains: <namespace>.svc.cluster.local, svc.cluster.local, cluster.local
        # searches:
        #   - production.svc.cluster.local
        #   - svc.cluster.local
        #   - cluster.local
```

### Application-Level FQDN Best Practices

```go
package config

import "fmt"

// ServiceDNS provides helper functions for constructing Kubernetes DNS names
// that bypass ndots search domain expansion overhead.
type ServiceDNS struct {
    // ClusterDomain is the Kubernetes cluster DNS suffix (typically cluster.local)
    ClusterDomain string
}

// FQDN returns a fully-qualified domain name for a Kubernetes service.
// Using FQDNs in application configuration avoids DNS search domain expansion,
// reducing DNS lookup latency from 5 queries to 1.
//
// Example: FQDN("redis-master", "caches") → "redis-master.caches.svc.cluster.local."
// The trailing dot is critical: it prevents any search domain expansion.
func (s ServiceDNS) FQDN(serviceName, namespace string) string {
    return fmt.Sprintf("%s.%s.svc.%s.", serviceName, namespace, s.ClusterDomain)
}

// HeadlessPodFQDN returns the DNS name for a StatefulSet pod.
// Example: HeadlessPodFQDN("kafka", "0", "messaging") →
//          "kafka-0.kafka-headless.messaging.svc.cluster.local."
func (s ServiceDNS) HeadlessPodFQDN(podName, headlessService, namespace string) string {
    return fmt.Sprintf("%s.%s.%s.svc.%s.", podName, headlessService, namespace, s.ClusterDomain)
}

// DefaultDNS is a ServiceDNS using the standard cluster domain.
var DefaultDNS = ServiceDNS{ClusterDomain: "cluster.local"}
```

## Section 7: Rewrite Rules

```yaml
# rewrite-plugin-examples.yaml
data:
  Corefile: |
    .:53 {
        errors
        health

        # ── Name rewrites ─────────────────────────────────────────────────────
        # Rewrite queries for a legacy hostname to a new service name
        # Use case: migrating services without updating all client configurations
        rewrite name old-service.example.com new-service.production.svc.cluster.local

        # Regex rewrite: map *.old-domain.internal to services in new namespace
        # api.old-domain.internal → api.new-namespace.svc.cluster.local
        rewrite name regex (.*)\.old-domain\.internal {1}.new-namespace.svc.cluster.local

        # ── EDNS0 rewriting ───────────────────────────────────────────────────
        # Add client subnet information to queries forwarded upstream
        # rewrite edns0 local set <hex-encoded-data>

        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }

        # Rewrite must come before forward to intercept the query
        forward . /etc/resolv.conf
        cache 30
        prometheus :9153
    }
```

## Section 8: Autopath Plugin

The autopath plugin enables CoreDNS to resolve short names without requiring clients to send multiple queries through the search domain list. Instead, CoreDNS itself attempts the search domain expansion server-side.

```yaml
# autopath-plugin.yaml
# autopath reduces DNS queries by 4-5x for short names
# Trade-off: CoreDNS does more work per query, but total system DNS load decreases
data:
  Corefile: |
    .:53 {
        errors
        health

        # autopath: expand search domains server-side
        # @kubernetes: use pod's namespace as search domain context
        # The fallthrough argument passes unresolved queries to the next plugin
        autopath @kubernetes

        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods verified     # autopath requires verified pod tracking
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }

        forward . /etc/resolv.conf
        cache 30
        prometheus :9153
    }
```

## Section 9: CoreDNS High Availability Deployment

```yaml
# coredns-ha-deployment.yaml
# Production CoreDNS deployment with HA configuration
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns
  namespace: kube-system
  labels:
    k8s-app: kube-dns
spec:
  # At least 2 replicas for HA; scale based on cluster size
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1

  selector:
    matchLabels:
      k8s-app: kube-dns

  template:
    metadata:
      labels:
        k8s-app: kube-dns
    spec:
      # Spread replicas across nodes and zones
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              k8s-app: kube-dns
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              k8s-app: kube-dns

      priorityClassName: system-cluster-critical

      tolerations:
        - key: "CriticalAddonsOnly"
          operator: "Exists"
        - effect: NoSchedule
          key: node-role.kubernetes.io/control-plane

      containers:
        - name: coredns
          image: registry.k8s.io/coredns/coredns:v1.11.1
          args:
            - -conf
            - /etc/coredns/Corefile
          volumeMounts:
            - name: config-volume
              mountPath: /etc/coredns
              readOnly: true
            - name: zone-files
              mountPath: /etc/coredns/zones
              readOnly: true
          resources:
            # Size based on cluster DNS query rate
            # Rule of thumb: 100m CPU + 70Mi memory per 1000 pods in the cluster
            requests:
              cpu: 100m
              memory: 70Mi
            limits:
              cpu: 1000m
              memory: 170Mi
          readinessProbe:
            httpGet:
              path: /ready
              port: 8181
              scheme: HTTP
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 2
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
              scheme: HTTP
            initialDelaySeconds: 60
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 5
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              add:
                - NET_BIND_SERVICE  # Allow binding to port 53
              drop:
                - ALL
            readOnlyRootFilesystem: true

      volumes:
        - name: config-volume
          configMap:
            name: coredns
            items:
              - key: Corefile
                path: Corefile
        - name: zone-files
          configMap:
            name: coredns-zone-files
---
# PodDisruptionBudget: ensure at least 2 CoreDNS pods are available during disruptions
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: coredns-pdb
  namespace: kube-system
spec:
  minAvailable: 2
  selector:
    matchLabels:
      k8s-app: kube-dns
```

## Section 10: Metrics and Debugging

### CoreDNS Prometheus Metrics

```yaml
# coredns-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: coredns-alerts
  namespace: monitoring
spec:
  groups:
    - name: coredns.alerts
      rules:
        # Alert when CoreDNS error rate exceeds 1%
        - alert: CoreDNSHighErrorRate
          expr: |
            (
              sum(rate(coredns_dns_responses_total{rcode!="NOERROR"}[5m]))
              /
              sum(rate(coredns_dns_responses_total[5m]))
            ) > 0.01
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CoreDNS error rate {{ $value | humanizePercentage }} exceeds threshold"
            runbook_url: "https://wiki.example.com/runbooks/coredns-errors"

        # Alert when CoreDNS P99 latency exceeds 100ms
        - alert: CoreDNSHighLatency
          expr: |
            histogram_quantile(0.99,
              sum(rate(coredns_dns_request_duration_seconds_bucket[5m])) by (le)
            ) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CoreDNS P99 latency {{ $value | humanizeDuration }} exceeds 100ms"

        # Alert when CoreDNS is not available
        - alert: CoreDNSDown
          expr: absent(up{job="coredns"}) OR sum(up{job="coredns"}) == 0
          for: 3m
          labels:
            severity: critical
          annotations:
            summary: "CoreDNS is down — cluster DNS resolution is failing"

        # Alert when CoreDNS cache hit rate drops
        - alert: CoreDNSLowCacheHitRate
          expr: |
            (
              sum(rate(coredns_cache_hits_total[5m]))
              /
              (sum(rate(coredns_cache_hits_total[5m])) + sum(rate(coredns_cache_misses_total[5m])))
            ) < 0.5
          for: 15m
          labels:
            severity: info
          annotations:
            summary: "CoreDNS cache hit rate {{ $value | humanizePercentage }} is low"
            description: "Low cache hit rate may indicate DNS TTLs are too short or cache size is insufficient."
```

### DNS Debugging Commands

```bash
#!/bin/bash
# debug-coredns.sh
# Comprehensive CoreDNS debugging toolkit

NAMESPACE="kube-system"
COREDNS_LABEL="k8s-app=kube-dns"

echo "=== CoreDNS Debugging Report ==="
echo ""

# 1. Check CoreDNS pod status
echo "--- CoreDNS Pod Status ---"
kubectl get pods -n ${NAMESPACE} -l ${COREDNS_LABEL} -o wide

# 2. Check for recent errors in CoreDNS logs
echo ""
echo "--- Recent CoreDNS Errors (last 5 min) ---"
kubectl logs -n ${NAMESPACE} \
  -l ${COREDNS_LABEL} \
  --since=5m \
  --prefix=true \
  | grep -i "error\|SERVFAIL\|panic\|plugin" \
  | head -50

# 3. Test DNS resolution from within the cluster
echo ""
echo "--- Testing DNS Resolution ---"

# Create a temporary debug pod for DNS testing
kubectl run dns-debug \
  --image=busybox:1.36 \
  --restart=Never \
  --rm -it \
  --namespace=production \
  -- sh -c '
    echo "Testing cluster DNS:"
    echo "--- kubernetes.default.svc.cluster.local ---"
    nslookup kubernetes.default.svc.cluster.local
    echo ""
    echo "--- coredns pod IP ---"
    nslookup coredns.kube-system.svc.cluster.local
    echo ""
    echo "--- External DNS ---"
    nslookup google.com
    echo ""
    echo "--- Timing full resolution ---"
    time nslookup kubernetes.default.svc.cluster.local
  ' 2>/dev/null || true

# 4. Check CoreDNS ConfigMap
echo ""
echo "--- Current CoreDNS Configuration ---"
kubectl get configmap coredns -n ${NAMESPACE} -o jsonpath='{.data.Corefile}'

# 5. Check metrics endpoint
echo ""
echo "--- CoreDNS Metrics Sample ---"
COREDNS_POD=$(kubectl get pods -n ${NAMESPACE} -l ${COREDNS_LABEL} \
  -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n ${NAMESPACE} ${COREDNS_POD} -- \
  wget -qO- http://localhost:9153/metrics 2>/dev/null \
  | grep -E "^coredns_dns_requests_total|^coredns_cache_hits|^coredns_cache_misses" \
  | head -20

# 6. Identify high DNS query sources
echo ""
echo "--- High DNS Query Pods (top 10) ---"
echo "Note: Requires metrics-server + custom metrics setup"
kubectl top pods --all-namespaces --sort-by=memory 2>/dev/null | head -11 || \
  echo "kubectl top requires metrics-server"
```

### DNS Query Tracing with the Log Plugin

```yaml
# coredns-debug-configmap.yaml
# Temporary: enable verbose logging for DNS debugging
# WARNING: Very verbose — disable in production after debugging
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors

        # log: logs every DNS query
        # Useful for debugging DNS resolution issues
        # DISABLE in production: generates enormous log volume
        log . {
            class all  # Log all query classes (IN, CHAOS, ANY)
        }

        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        forward . /etc/resolv.conf
        cache 30
        prometheus :9153
        reload
    }
```

## Summary

CoreDNS configuration complexity scales with the sophistication of the DNS infrastructure it must integrate with. The critical performance tuning priorities are:

**Cache configuration**: The default 30-second cache is insufficient for most production workloads. Kubernetes service IPs are stable—a 300-second cache reduces upstream query load by an order of magnitude for well-cached record sets. Prefetch eliminates the cache miss spikes that occur when hot records expire.

**ndots tuning**: The default `ndots:5` causes 5 DNS queries for every short name lookup. Applications using FQDNs (ending with a dot) or configuring `ndots:2` in pod DNS config reduce lookup latency significantly for high-query-rate services.

**Split-horizon and rewrite rules**: Hybrid cloud environments require DNS to serve different answers based on the query source. CoreDNS's rewrite and template plugins implement split-horizon DNS entirely in the Corefile, without requiring separate DNS servers for internal and external resolution.

**HA deployment**: CoreDNS is a critical cluster infrastructure component. Three replicas with topology spread constraints, a PodDisruptionBudget of minAvailable:2, and the `system-cluster-critical` priority class ensure CoreDNS survives node failures and maintenance operations without interrupting cluster DNS resolution.
