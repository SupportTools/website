---
title: "Kubernetes StatefulSet Headless Services: DNS, Stable Network Identities, and Peer Discovery"
date: 2029-03-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "StatefulSet", "DNS", "Distributed Systems", "Database", "Networking"]
categories:
- Kubernetes
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes StatefulSet headless services, covering DNS resolution mechanics for stable pod identities, peer discovery patterns for distributed databases, ordinal-based initialization, and operational patterns for Cassandra, etcd, and Redis Cluster."
more_link: "yes"
url: "/kubernetes-statefulset-headless-services-dns-stable-network-peer-discovery/"
---

StatefulSets provide two guarantees that distinguish them from Deployments: stable storage (PersistentVolumeClaims that survive pod restarts) and stable network identity (predictable pod names and DNS records). The network identity guarantee depends on a **headless service**—a Service with `clusterIP: None` that instructs CoreDNS to return individual pod A records rather than a single ClusterIP.

Distributed databases, consensus systems, and peer-to-peer clusters rely on this mechanism for initial bootstrap and ongoing peer discovery. Understanding exactly how DNS records are created and updated, and the timing relationship between StatefulSet rollout and DNS availability, is critical for writing reliable distributed application initialization code.

<!--more-->

## Headless Service DNS Mechanics

### Standard Service vs. Headless Service

A standard Kubernetes Service with `clusterIP: 10.96.0.50` creates a single DNS A record:

```
postgres.production.svc.cluster.local → 10.96.0.50
```

Traffic to `10.96.0.50` is load-balanced by kube-proxy or Cilium across all matching pods using iptables or eBPF rules. The caller never knows which pod IP was selected.

A headless Service with `clusterIP: None` creates a DNS A record for **each** ready pod:

```
postgres.production.svc.cluster.local → 10.244.1.5 (postgres-0)
                                      → 10.244.2.7 (postgres-1)
                                      → 10.244.3.2 (postgres-2)
```

Additionally, each StatefulSet pod gets its own SRV record and A record:

```
# Per-pod stable DNS names
postgres-0.postgres.production.svc.cluster.local → 10.244.1.5
postgres-1.postgres.production.svc.cluster.local → 10.244.2.7
postgres-2.postgres.production.svc.cluster.local → 10.244.3.2
```

The pattern is: `{pod-name}.{service-name}.{namespace}.svc.{cluster-domain}`.

### DNS Record Lifecycle

DNS records for StatefulSet pods are created and removed in coordination with the pod's lifecycle:

1. When pod `postgres-0` is **created**, the A record for `postgres-0.postgres.production.svc.cluster.local` is added immediately—before the pod is Ready.
2. The pod's IP is included in the headless service A record set only when the pod passes its readiness probe.
3. When the pod is **deleted**, the per-pod A record is removed. The pod's IP is removed from the service A record set when the pod becomes NotReady (before deletion).

This means peer discovery using the per-pod hostname (`postgres-0.postgres`) is reliable even before a pod is Ready, which is essential for bootstrapping distributed systems that require peer-to-peer connections during initialization.

---

## StatefulSet with Headless Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: production
  labels:
    app: postgres
spec:
  clusterIP: None      # Headless: no virtual IP, return individual pod IPs
  publishNotReadyAddresses: true   # Include pods even before readiness passes
  selector:
    app: postgres
  ports:
    - name: postgres
      port: 5432
      protocol: TCP
    - name: patroni
      port: 8008
      protocol: TCP
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: production
spec:
  serviceName: postgres    # MUST match the headless service name
  replicas: 3
  selector:
    matchLabels:
      app: postgres
  podManagementPolicy: OrderedReady   # Start pods in order: postgres-0, then postgres-1, then postgres-2
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0
  template:
    metadata:
      labels:
        app: postgres
    spec:
      terminationGracePeriodSeconds: 120
      initContainers:
        - name: init-permissions
          image: busybox:1.36
          command: ["sh", "-c", "chown -R 999:999 /var/lib/postgresql/data"]
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      containers:
        - name: postgres
          image: postgres:16.3-alpine
          ports:
            - containerPort: 5432
              name: postgres
          env:
            - name: POSTGRES_DB
              value: appdb
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-credentials
                  key: password
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          readinessProbe:
            exec:
              command: ["/bin/sh", "-c", "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB"]
            initialDelaySeconds: 15
            periodSeconds: 10
            failureThreshold: 3
          livenessProbe:
            exec:
              command: ["/bin/sh", "-c", "pg_isready -U $POSTGRES_USER"]
            initialDelaySeconds: 30
            periodSeconds: 30
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2000m"
              memory: "4Gi"
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
            - name: config
              mountPath: /etc/postgresql
      volumes:
        - name: config
          configMap:
            name: postgres-config
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: premium-ssd
        resources:
          requests:
            storage: 100Gi
```

### publishNotReadyAddresses

The `publishNotReadyAddresses: true` flag on the Service is important for distributed database bootstrapping. Without it, DNS returns empty results for pods that have not yet passed their readiness probe. During initial cluster formation, pods attempt to contact peers that have not yet started. Setting this flag ensures DNS records are available immediately when pod IPs are assigned, before any probes pass.

---

## Peer Discovery Patterns

### Pattern 1: Known Hostnames (Etcd, Consul)

When the cluster size is fixed and known at deploy time, enumerate all pod hostnames directly:

```go
// peer_discovery.go
package cluster

import (
	"fmt"
	"os"
)

// PeersFromStatefulSet returns the list of peer addresses for a StatefulSet member.
// Each member knows its own ordinal from the pod hostname.
func PeersFromStatefulSet(serviceName, namespace string, replicas int) []string {
	peers := make([]string, replicas)
	for i := 0; i < replicas; i++ {
		peers[i] = fmt.Sprintf("%s-%d.%s.%s.svc.cluster.local:2380",
			os.Getenv("STATEFULSET_NAME"), i, serviceName, namespace)
	}
	return peers
}

// SelfID returns the ordinal of the current pod.
// The hostname for StatefulSet pods is always "{name}-{ordinal}".
func SelfID() int {
	hostname, _ := os.Hostname()
	var ordinal int
	_, _ = fmt.Sscanf(hostname, "%*[^-]-%d", &ordinal)
	return ordinal
}

// IsBootstrapNode returns true if this pod should act as the initial seed.
// Ordinal 0 is always the bootstrap node.
func IsBootstrapNode() bool {
	return SelfID() == 0
}
```

### Pattern 2: DNS SRV Lookup (Dynamic Membership)

For clusters that resize dynamically, DNS SRV lookups against the headless service return all current members:

```go
// discovery/srv.go
package discovery

import (
	"fmt"
	"net"
	"sort"
	"time"
)

// DiscoverPeersViaSRV queries the headless service SRV record to find all
// current members of a StatefulSet cluster.
func DiscoverPeersViaSRV(serviceName, namespace string, port string, timeout time.Duration) ([]string, error) {
	srvHost := fmt.Sprintf("%s.%s.svc.cluster.local", serviceName, namespace)

	resolver := &net.Resolver{
		PreferGo: true,
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, addrs, err := resolver.LookupSRV(
			context.Background(), "", "tcp", srvHost)
		if err == nil && len(addrs) > 0 {
			peers := make([]string, 0, len(addrs))
			for _, addr := range addrs {
				// Trim trailing dot from FQDN
				host := strings.TrimSuffix(addr.Target, ".")
				peers = append(peers, fmt.Sprintf("%s:%s", host, port))
			}
			sort.Strings(peers)
			return peers, nil
		}
		time.Sleep(2 * time.Second)
	}
	return nil, fmt.Errorf("timeout waiting for SRV records for %s", srvHost)
}
```

### Pattern 3: Ordinal-Based Role Assignment

Many distributed systems require a designated leader/primary for initial cluster formation. The pod with ordinal 0 is a natural choice:

```bash
#!/usr/bin/env bash
# entrypoint.sh — Determine role based on StatefulSet ordinal

POD_NAME=${HOSTNAME}
ORDINAL=${POD_NAME##*-}
REPLICA_COUNT=${REPLICA_COUNT:-3}
SERVICE_NAME=${SERVICE_NAME:-redis-cluster}
NAMESPACE=${NAMESPACE:-production}

# Build the list of peer addresses
PEERS=""
for i in $(seq 0 $((REPLICA_COUNT - 1))); do
  PEERS="$PEERS ${SERVICE_NAME}-${i}.${SERVICE_NAME}.${NAMESPACE}.svc.cluster.local:6379"
done
PEERS="${PEERS# }"  # trim leading space

if [[ "$ORDINAL" == "0" ]]; then
  echo "Starting as cluster initiator (ordinal 0)"
  exec redis-server /etc/redis/redis.conf \
    --cluster-enabled yes \
    --cluster-config-file /data/nodes.conf \
    --cluster-node-timeout 5000 \
    --appendonly yes
else
  echo "Starting as cluster member (ordinal ${ORDINAL})"
  # Wait for ordinal 0 to be ready before joining
  until redis-cli -h "${SERVICE_NAME}-0.${SERVICE_NAME}.${NAMESPACE}.svc.cluster.local" ping; do
    echo "Waiting for seed node..."
    sleep 2
  done
  exec redis-server /etc/redis/redis.conf \
    --cluster-enabled yes \
    --cluster-config-file /data/nodes.conf \
    --cluster-node-timeout 5000 \
    --appendonly yes
fi
```

---

## Redis Cluster StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: production
spec:
  serviceName: redis-cluster
  replicas: 6
  podManagementPolicy: Parallel   # Start all pods simultaneously for cluster formation
  selector:
    matchLabels:
      app: redis-cluster
  template:
    metadata:
      labels:
        app: redis-cluster
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - topologyKey: kubernetes.io/hostname
              labelSelector:
                matchLabels:
                  app: redis-cluster
      containers:
        - name: redis
          image: redis:7.2-alpine
          command:
            - redis-server
            - /etc/redis/redis.conf
          ports:
            - containerPort: 6379
              name: client
            - containerPort: 16379
              name: gossip
          readinessProbe:
            exec:
              command: [redis-cli, ping]
            initialDelaySeconds: 10
            periodSeconds: 5
          env:
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          volumeMounts:
            - name: data
              mountPath: /data
            - name: config
              mountPath: /etc/redis
        - name: cluster-init
          image: redis:7.2-alpine
          command: ["/scripts/init-cluster.sh"]
          env:
            - name: REDIS_NODES
              value: "6"
            - name: SERVICE_NAME
              value: redis-cluster
            - name: NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
          volumeMounts:
            - name: scripts
              mountPath: /scripts
      volumes:
        - name: config
          configMap:
            name: redis-cluster-config
        - name: scripts
          configMap:
            name: redis-cluster-scripts
            defaultMode: 0755
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: standard
        resources:
          requests:
            storage: 10Gi
```

### Parallel Pod Management

`podManagementPolicy: Parallel` starts all replicas simultaneously, without waiting for each to be Ready before starting the next. This is appropriate for Redis Cluster where all nodes must be available before the cluster can be formed. Use `OrderedReady` for primary-replica databases (like PostgreSQL with Patroni) where the primary must start before the replicas.

---

## DNS Debugging

```bash
# From a debug pod in the same namespace, verify DNS records
kubectl run dns-debug -n production \
  --image=registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3 \
  --rm -it --restart=Never \
  -- /bin/bash

# Inside the debug pod:
nslookup postgres.production.svc.cluster.local
# Returns A records for all ready postgres pods

nslookup postgres-0.postgres.production.svc.cluster.local
# Returns the specific A record for postgres-0

# SRV records
dig SRV _postgres._tcp.postgres.production.svc.cluster.local
# ;; ANSWER SECTION:
# _postgres._tcp.postgres.production.svc.cluster.local. 5 IN SRV 10 33 5432 postgres-0.postgres.production.svc.cluster.local.
# _postgres._tcp.postgres.production.svc.cluster.local. 5 IN SRV 10 33 5432 postgres-1.postgres.production.svc.cluster.local.
# _postgres._tcp.postgres.production.svc.cluster.local. 5 IN SRV 10 33 5432 postgres-2.postgres.production.svc.cluster.local.

# Check CoreDNS is processing the query correctly
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=20
```

---

## Operational Patterns

### Scaling Down Without Data Loss

StatefulSets scale down from the highest ordinal. Ensure the application drains data from pods before the StatefulSet controller removes them:

```yaml
# Use a preStop hook to signal the application to drain before termination
lifecycle:
  preStop:
    exec:
      command:
        - /bin/sh
        - -c
        - |
          # For Redis Cluster: move slots away from this node before shutdown
          SELF_ID=$(redis-cli -p 6379 cluster myid)
          redis-cli -p 6379 cluster failover
          sleep 10
```

### Forced Pod Restart Without PVC Deletion

```bash
# Delete only the pod (StatefulSet recreates it), preserving the PVC
kubectl delete pod postgres-1 -n production

# Watch recreation
kubectl get pods -n production -l app=postgres -w
```

### PVC Cleanup After Scale-Down

StatefulSet scale-down does NOT delete PVCs. Clean up manually:

```bash
# After scaling from 3 to 2 replicas:
kubectl delete pvc data-postgres-2 -n production
```

As of Kubernetes 1.27, the `persistentVolumeClaimRetentionPolicy` field automates this:

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain   # Keep PVCs when StatefulSet is deleted
    whenScaled: Delete    # Delete PVCs when scaling down
```

---

## Summary

Kubernetes StatefulSets with headless services provide the stable network identity that distributed databases require:

| Concept | Implementation |
|---------|---------------|
| Stable pod hostname | `{name}-{ordinal}` format, predictable before pod starts |
| Per-pod DNS A record | `{pod}.{service}.{namespace}.svc.cluster.local` |
| Peer discovery during bootstrap | `publishNotReadyAddresses: true` + known hostnames |
| Dynamic member discovery | SRV record lookup against headless service |
| Role assignment | Ordinal 0 as primary/seed node |
| Ordered vs. parallel startup | `OrderedReady` for primary-replica, `Parallel` for peer-to-peer |

The combination of stable DNS names, `publishNotReadyAddresses`, and ordinal-based role assignment eliminates the need for external service discovery systems (Consul, ZooKeeper) for most Kubernetes-native distributed database deployments.
