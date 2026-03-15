---
title: "EFK Stack on Kubernetes: Production Deployment with ECK and Fluent Operator"
date: 2026-03-14T12:00:00-05:00
draft: false
tags: ["Kubernetes", "Elasticsearch", "Fluent Bit", "Kibana", "Logging", "Observability", "ECK Operator", "Fluent Operator", "Log Aggregation", "DevOps", "Production", "RKE2"]
categories: ["Kubernetes", "Observability", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy a production-grade EFK stack on Kubernetes using ECK Operator for Elasticsearch and Kibana lifecycle management and Fluent Operator for declarative Fluent Bit CRD-based configuration."
more_link: "yes"
url: "/efk-stack-kubernetes-production-eck-fluent-operator/"
---

Container logs are ephemeral by design — when a pod restarts, its logs vanish unless captured externally. At scale, that means thousands of log streams rotating across hundreds of nodes, with no reliable way to correlate events across service boundaries without centralized log aggregation. The **EFK stack** — Elasticsearch, Fluent Bit, and Kibana — solves this by collecting every log line at the node level, indexing it in a searchable store, and surfacing it through a powerful query interface.

The catch is that the raw-YAML DaemonSet approach most tutorials demonstrate breaks down in production: manual TLS certificate rotation, hand-edited ConfigMaps for log routing changes, and no safe upgrade path for Elasticsearch nodes. This guide uses two Kubernetes operators instead — **ECK Operator** (Elastic Cloud on Kubernetes) to manage the full lifecycle of Elasticsearch and Kibana via CRDs, and **Fluent Operator** to express Fluent Bit configuration as native Kubernetes resources with dynamic reload support. The result is a GitOps-ready logging platform that survives node failures, version upgrades, and configuration drift.

<!--more-->

## Why Operators? ECK + Fluent Operator vs. Raw Manifests

The operator pattern exists to encode operational knowledge into the control plane. For stateful workloads like Elasticsearch, that knowledge is substantial: rolling upgrades without data loss require careful shard migration, certificate rotation requires coordinated restarts, and scaling data nodes requires rebalancing before and after. Doing all of this manually with raw StatefulSets and ConfigMaps is possible but error-prone.

**ECK Operator** (Elastic Cloud on Kubernetes) handles all of this automatically. When the `Elasticsearch` CRD spec changes — whether that's a version bump or a node count increase — ECK computes a safe migration path and executes it, watching shard health at each step before proceeding. It automatically provisions TLS certificates for both the HTTP API and transport layer, stores the `elastic` superuser password in a Kubernetes Secret, and integrates with Kubernetes PVCs for persistent storage.

**Fluent Operator** applies the same philosophy to Fluent Bit. Rather than editing a monolithic ConfigMap and restarting pods, the operator exposes the full Fluent Bit pipeline — inputs, parsers, filters, and outputs — as separate CRDs. When any CRD changes, the operator regenerates the config Secret and signals Fluent Bit to reload without a pod restart. This makes log routing changes safe to apply via `kubectl apply` or a GitOps tool like ArgoCD.

| Capability | Raw DaemonSet / StatefulSet | ECK + Fluent Operator |
|---|---|---|
| TLS certificate management | Manual rotation, downtime risk | Automatic via ECK |
| Elasticsearch rolling upgrades | Manual shard migration | Automated with health checks |
| Fluent Bit config changes | Pod restart required | Dynamic reload, zero downtime |
| GitOps compatibility | Possible but fragile | Native CRD model |
| Password secret lifecycle | Manual | ECK auto-generates and rotates |
| Multi-cluster support | Complex | Fluent Operator ClusterOutput routing |

## Architecture Overview

The data flow is straightforward: Fluent Bit runs as a **DaemonSet** on every node, reading container logs from `/var/log/containers/` on the host filesystem. Each log line is enriched with Kubernetes metadata (pod name, namespace, labels) via the Kubernetes filter plugin before being forwarded to Elasticsearch. Kibana provides the query and visualization layer, connecting to Elasticsearch via the internal Kubernetes service.

```text
┌──────────────────────────────────────────────────┐
│                  Kubernetes Node                  │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Fluent Bit (DaemonSet pod)              │    │
│  │  - Reads /var/log/containers/*.log       │    │
│  │  - Enriches with k8s metadata            │    │
│  │  - Filters and parses JSON/text logs     │    │
│  └──────────────────┬───────────────────────┘    │
└─────────────────────│────────────────────────────┘
                      │  ClusterOutput (HTTPS/9200)
                      ▼
┌──────────────────────────────────────────────────┐
│  Namespace: es-operator                          │
│                                                  │
│  ┌──────────────────────────────────┐            │
│  │  Elasticsearch (StatefulSet)     │            │
│  │  - ECK-managed TLS               │            │
│  │  - PVC-backed storage            │            │
│  │  - ILM index lifecycle           │            │
│  └──────────────────┬───────────────┘            │
│                     │                            │
│  ┌──────────────────▼───────────────┐            │
│  │  Kibana (Deployment)             │            │
│  │  - elasticsearchRef auto-wiring  │            │
│  │  - Discover, Dashboards, Alerts  │            │
│  └──────────────────────────────────┘            │
└──────────────────────────────────────────────────┘

Namespace: fluent
  Fluent Operator (Deployment) — watches CRDs, assembles config
  Fluent Bit (DaemonSet) — one pod per node
```

The two-namespace design — `es-operator` for Elasticsearch/Kibana and `fluent` for the log shipping layer — is deliberate. It allows RBAC isolation between teams (platform team owns `es-operator`, application teams can read logs via Kibana without accessing the `fluent` namespace), and it makes it easier to replace components independently. The trade-off is a cross-namespace secret copy step covered in detail in Section 9.

## EFK vs. Loki: When to Choose Which

Both EFK and Loki solve the same problem, but with fundamentally different trade-offs. Understanding the distinction prevents over-engineering and helps match the tool to the workload.

**Elasticsearch (EFK)** indexes the full content of every log line. This makes arbitrary full-text search fast — querying for a specific error message, a UUID buried in a JSON payload, or a regex across log bodies is sub-second even on billions of documents. The cost is storage: a compressed Elasticsearch index typically consumes 2–4x the raw log volume.

**Loki** indexes only labels (metadata), not log content. Log lines are stored as compressed chunks against those labels. Queries that filter by label (namespace, pod, level) are fast; full-text search requires scanning chunks and is slower. Storage consumption is typically 5–10x lower than Elasticsearch for equivalent log volumes.

| Dimension | EFK (Elasticsearch) | Loki |
|---|---|---|
| Full-text search performance | Excellent (indexed) | Slow (chunk scan) |
| Storage efficiency | Poor (2–4x raw) | Excellent (5–10x less than ES) |
| Schema flexibility | Any JSON structure | Label-based filtering |
| Query language | KQL / Elasticsearch DSL | LogQL (Prometheus-like) |
| Operational complexity | High (JVM, shards, ILM) | Low (stateless, object storage) |
| Best for | Audit logs, security, compliance, full-text search | Application logs, cost-sensitive environments |

Choose EFK when: security teams need full-text search across audit logs, compliance requires structured query with field-level filtering, or log content is semi-structured JSON that benefits from Elasticsearch's ingest pipeline capabilities.

Choose Loki when: log volume is high and budget is constrained, queries are primarily label-based (namespace/pod/level), or the team already operates Grafana and wants a unified observability stack. The [Grafana Loki production deployment guide](/grafana-loki-log-aggregation-scale-production/) on this blog covers that path in detail.

## Prerequisites and Namespace Setup

The following are required before starting:

- **Kubernetes cluster**: This guide is tested on RKE2 v1.28+. The steps apply equally to any Kubernetes distribution, but storage class names and node taints vary.
- **Helm 3.12+**: Install via the [official Helm documentation](https://helm.sh/docs/intro/install/)
- **kubectl**: Configured with cluster admin access
- **Persistent storage**: A default `StorageClass` that supports `ReadWriteOnce` PVCs. On RKE2 with Longhorn, this is `longhorn`. Adjust `storageClassName` in the YAML examples to match the cluster.

Create the namespaces before deploying anything:

```bash
# Create namespaces with idempotent apply
kubectl create namespace es-operator --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace fluent --dry-run=client -o yaml | kubectl apply -f -
```

Using `--dry-run=client -o yaml | kubectl apply -f -` makes namespace creation idempotent — safe to re-run in CI pipelines without failing on "already exists" errors.

## Installing the ECK Operator

ECK is distributed as a Helm chart. The chart installs the operator deployment, CRDs, RBAC resources, and the admission webhook that validates Elasticsearch and Kibana resources before they are applied.

```bash
# Add the Elastic Helm repository
helm repo add elastic https://helm.elastic.co
helm repo update

# Install ECK Operator into the es-operator namespace
helm upgrade --install eck-operator elastic/eck-operator \
  -n es-operator \
  --create-namespace \
  -f eck-operator-values.yaml
```

The Helm values file controls operator behavior:

```yaml
# eck-operator-values.yaml
installCRDs: true          # let Helm manage CRD lifecycle
replicaCount: 1
resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 200Mi
webhook:
  enabled: true
  failurePolicy: Ignore    # do not block cluster operations if webhook is unavailable
  manageCerts: true        # ECK self-manages TLS for the admission webhook
config:
  logVerbosity: "0"
  metrics:
    port: 9090
```

The `failurePolicy: Ignore` setting on the webhook deserves attention. With `Fail` (the alternative), a temporary ECK operator pod restart would block all Elasticsearch and Kibana changes cluster-wide. `Ignore` allows operations to proceed even if the webhook is temporarily unavailable, trading strict validation for availability.

Verify the CRDs are installed:

```bash
# Expected output includes: agents, beats, elasticmapsservers, elasticsearches, kibanas...
kubectl get crds | grep elastic.co
```

## Deploying Elasticsearch via CRD

With ECK installed, Elasticsearch is declared as a custom resource rather than a raw StatefulSet. ECK reconciles the desired state — node count, configuration, resources — against the actual cluster state continuously.

### The JVM Heap Sizing Rule

Before writing the CRD, the most critical parameter must be understood: **JVM heap size**. Elasticsearch uses the JVM heap for indexing buffers, filter caches, and aggregation operations. The remaining memory goes to the OS page cache, which Lucene uses heavily for segment reads.

The rule is fixed: **set heap to exactly 50% of the pod memory limit, never exceed 31 GB**.

- With `limits.memory: 2Gi`, set `ES_JAVA_OPTS: "-Xms1g -Xmx1g"`
- With `limits.memory: 8Gi`, set `ES_JAVA_OPTS: "-Xms4g -Xmx4g"`
- `-Xms` and `-Xmx` must be identical — Elasticsearch pre-allocates the full heap to prevent GC pauses from heap expansion

The 31 GB cap exists because of the JVM's compressed object pointer (OOP) optimization: above ~32 GB, pointers expand from 4 bytes to 8 bytes, increasing memory consumption by 30–40% and degrading GC performance.

### Single-Node Development Deployment

For development and testing, a single-node deployment with all roles combined is acceptable:

```yaml
# elasticsearch-dev.yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: quickstart
  namespace: es-operator
spec:
  version: 8.12.2
  nodeSets:
  - name: default
    count: 1
    config:
      # Combine all roles on a single node for dev — never do this in production
      node.roles: ["master", "data", "ingest"]
      # Required on Kubernetes: mmap is restricted by default; disable virtual memory maps
      node.store.allow_mmap: false
      xpack.ml.enabled: false          # saves ~500MB RAM in dev
      xpack.security.enabled: true     # TLS + auth always on via ECK
      xpack.watcher.enabled: false
    podTemplate:
      spec:
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 1Gi
              cpu: 200m
            limits:
              memory: 2Gi              # heap = 50% of limit = 1Gi
              cpu: 1000m
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms1g -Xmx1g"   # must equal 50% of limits.memory
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 30Gi
        storageClassName: longhorn     # RKE2 default with Longhorn CSI
```

Apply and watch the cluster come up:

```bash
kubectl apply -f elasticsearch-dev.yaml

# Watch until health shows "green" — this takes 2-3 minutes on first pull
kubectl -n es-operator get elasticsearch -w

# Output should reach:
# NAME         HEALTH   NODES   VERSION   PHASE   AGE
# quickstart   green    1       8.12.2    Ready   3m
```

ECK automatically creates a Secret named `<cluster-name>-es-elastic-user` containing the generated `elastic` password:

```bash
# Retrieve the auto-generated elastic superuser password
kubectl get secret quickstart-es-elastic-user \
  -n es-operator \
  -o jsonpath='{.data.elastic}' | base64 --decode
```

### Production Node Role Separation

In production, separating master, data, and ingest roles onto distinct node sets prevents a data-heavy workload from starving master nodes of CPU, which causes election timeouts and cluster instability. The production spec uses `requiredDuringSchedulingIgnoredDuringExecution` pod anti-affinity to spread each role across separate Kubernetes nodes:

```yaml
# elasticsearch-prod.yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: logging
  namespace: es-operator
spec:
  version: 8.12.2
  nodeSets:
  # Dedicated master nodes — coordination only, no data
  - name: master
    count: 3
    config:
      node.roles: ["master"]
      node.store.allow_mmap: false
      xpack.security.enabled: true
    podTemplate:
      spec:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  elasticsearch.k8s.elastic.co/statefulset-name: logging-es-master
              topologyKey: kubernetes.io/hostname
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 2Gi
              cpu: 500m
            limits:
              memory: 2Gi    # requests == limits for Guaranteed QoS
              cpu: 1000m
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms1g -Xmx1g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 10Gi
        storageClassName: longhorn
  # Data nodes — heavy workload, large storage
  - name: data
    count: 3
    config:
      node.roles: ["data", "ingest"]
      node.store.allow_mmap: false
      xpack.security.enabled: true
    podTemplate:
      spec:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  elasticsearch.k8s.elastic.co/statefulset-name: logging-es-data
              topologyKey: kubernetes.io/hostname
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 8Gi
              cpu: 2000m
            limits:
              memory: 8Gi    # requests == limits for Guaranteed QoS
              cpu: 4000m
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms4g -Xmx4g"   # 50% of 8Gi limit
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 500Gi
        storageClassName: longhorn
```

Setting `requests == limits` for both master and data nodes achieves **Guaranteed QoS** in Kubernetes. This means the kubelet will never evict these pods under memory pressure — critical for a stateful workload where eviction would trigger shard re-replication across the remaining nodes, temporarily degrading write throughput and increasing network traffic.

## Deploying Kibana via CRD

Kibana connects to Elasticsearch through the `elasticsearchRef` field in its CRD. ECK resolves this reference to the actual Elasticsearch service endpoint, injects the CA certificate, and creates a Kibana configuration Secret with the correct credentials. Manual wiring of the `elasticsearch.hosts` and `elasticsearch.password` settings is not required.

```yaml
# kibana.yaml
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: quickstart
  namespace: es-operator
spec:
  version: 8.12.2
  count: 1
  # ECK resolves the endpoint, port, and credentials from the named Elasticsearch resource
  elasticsearchRef:
    name: quickstart
  config:
    # Must match the actual hostname used to reach Kibana; affects OAuth redirect URIs
    server.publicBaseUrl: "https://kibana.logging.example.com"
  podTemplate:
    spec:
      containers:
      - name: kibana
        resources:
          requests:
            memory: 512Mi
            cpu: 200m
          limits:
            memory: 1Gi
            cpu: 1000m
```

Apply and verify:

```bash
kubectl apply -f kibana.yaml

# Wait for Kibana pods to be Ready
kubectl get pods,svc -n es-operator -l common.k8s.elastic.co/type=kibana

# For local access — production should use an Ingress with TLS termination
kubectl port-forward service/quickstart-kb-http -n es-operator 5601
```

Access Kibana at `https://localhost:5601`. The username is `elastic` and the password is the value retrieved in the Elasticsearch section. For RKE2 environments, configure an Ingress using the nginx-ingress controller or Traefik with TLS passthrough to avoid double-TLS complexity with ECK's self-signed certs:

```bash
# Production: configure ingress to reach Kibana via the ECK-managed service
# The service name follows the pattern: <kibana-name>-kb-http
kubectl get svc -n es-operator | grep kb-http
```

## Installing the Fluent Operator

The Fluent Operator manages both Fluent Bit and Fluentd via CRDs. In this single-cluster EFK setup, only Fluent Bit is needed — Fluentd is disabled. Install from the Helm chart:

```bash
# Add the Fluent Helm repository
helm repo add fluent https://fluent.github.io/helm-charts
helm repo update

# Install Fluent Operator into its own namespace
helm upgrade --install fluent-operator fluent/fluent-operator \
  -n fluent \
  --create-namespace \
  -f fluent-operator-values.yaml
```

```yaml
# fluent-operator-values.yaml
Kubernetes: true           # enable Kubernetes-specific input/enrichment CRDs

operator:
  enable: true
  resources:
    limits:
      cpu: 50m
      memory: 50Mi
    requests:
      cpu: 10m
      memory: 20Mi

fluentbit:
  enable: true
  # Fluent Operator requires its own Fluent Bit image for dynamic config reload support
  # The upstream fluent/fluent-bit image does NOT support the operator's reload mechanism
  resources:
    limits:
      cpu: 100m
      memory: 100Mi
    requests:
      cpu: 10m
      memory: 25Mi

# Fluentd is not needed in this single-cluster EFK setup
fluentd:
  enable: false
```

The custom image requirement is a common source of confusion. The standard `fluent/fluent-bit` image from Docker Hub does not include the `fluent-bit-watcher` binary that the operator relies on for config reload signaling. Helm pulls the operator-specific image automatically from `ghcr.io/fluent/fluent-operator/fluent-bit` when `fluentbit.enable: true` is set.

Verify the operator is running and CRDs are registered:

```bash
# Check operator and DaemonSet pods
kubectl -n fluent get pods

# Expected output includes: fluent-operator-*, fluent-bit-* (one per node)

# Verify Fluent Bit CRDs are available
kubectl get crd | grep fluent
# Expected: clusterfilters, clusterfluentbitconfigs, clusterinputs, clusteroutputs, clusterparsers
```

## Wiring Fluent Bit to Elasticsearch

This section connects the two halves of the EFK stack. Three steps are involved: solving the cross-namespace secret access problem, validating log collection with a stdout output, then switching to the Elasticsearch output.

### The Cross-Namespace Secret Problem

ECK creates the `elastic` password Secret in the `es-operator` namespace:

```
Secret: quickstart-es-elastic-user
Namespace: es-operator
```

Fluent Bit runs in the `fluent` namespace and needs to reference this Secret in its `ClusterOutput` CRD via `secretKeyRef`. In Kubernetes, `secretKeyRef` can only reference Secrets within the same namespace as the pod consuming them — cross-namespace Secret references are not supported.

The solution is to copy the Secret from `es-operator` into `fluent`, editing the namespace field in transit:

```bash
# Copy the ECK-generated password Secret into the fluent namespace
kubectl get secret quickstart-es-elastic-user \
  -n es-operator \
  -o yaml \
  | sed 's/namespace: es-operator/namespace: fluent/' \
  | kubectl apply -f -

# Create a separate Secret for the username string
# ClusterOutput requires separate Secrets for username and password
kubectl create secret generic elastic-username \
  --from-literal=username=elastic \
  -n fluent \
  --dry-run=client -o yaml | kubectl apply -f -
```

This is the most common silent failure in an EFK deployment: if the secrets are not present in the `fluent` namespace, Fluent Bit will log repeated connection errors against the Elasticsearch endpoint but will not clearly report the authentication failure cause. Always verify the secrets exist in the correct namespace before debugging further:

```bash
kubectl get secrets -n fluent | grep elastic
# Expected output:
# elastic-username                 Opaque   1      ...
# quickstart-es-elastic-user       Opaque   1      ...
```

Note that when ECK rotates the Elasticsearch password (on operator restart or manual trigger), this copied Secret becomes stale. For production environments, consider using the [External Secrets Operator](https://external-secrets.io/) to sync the secret automatically, or implement a CronJob that periodically refreshes the copy.

### Debugging with Stdout ClusterOutput First

Before pointing Fluent Bit at Elasticsearch, validate that log collection is working with a stdout output. This eliminates authentication and network connectivity as variables when troubleshooting collection issues.

```yaml
# cluster-output-stdout.yaml
apiVersion: fluentbit.fluent.io/v1alpha2
kind: ClusterOutput
metadata:
  name: stdout-debug
  labels:
    # This label is required — the operator ignores CRDs without it
    fluentbit.fluent.io/enabled: "true"
spec:
  # Match logs from pods whose name matches the regex
  # Adjust the pattern to target a specific application for testing
  matchRegex: (?:kube|service)\.(?:var\.log\.containers\.nginx.*)
  stdout:
    format: json
```

Apply and check the Fluent Bit pod logs:

```bash
kubectl apply -f cluster-output-stdout.yaml

# Tail Fluent Bit logs — look for JSON-formatted log lines from matched pods
kubectl logs -n fluent \
  -l app.kubernetes.io/name=fluent-bit \
  --tail=50
```

If JSON log lines from the matched pods appear, the DaemonSet is collecting and processing logs correctly. Delete or disable this `ClusterOutput` before applying the Elasticsearch output to avoid duplicate forwarding.

### Production Elasticsearch ClusterOutput

With the secrets in place and collection validated, apply the Elasticsearch output:

```yaml
# cluster-output-es.yaml
apiVersion: fluentbit.fluent.io/v1alpha2
kind: ClusterOutput
metadata:
  name: elasticsearch
  labels:
    fluentbit.fluent.io/enabled: "true"
spec:
  matchRegex: (?:kube|service)\..*   # forward all kube and service logs
  es:
    # Internal service DNS: <es-name>-es-http.<namespace>.svc
    host: quickstart-es-http.es-operator.svc
    port: 9200
    httpUser:
      valueFrom:
        secretKeyRef:
          name: elastic-username
          key: username
    httpPassword:
      valueFrom:
        secretKeyRef:
          # ECK-generated password secret, copied from es-operator namespace
          name: quickstart-es-elastic-user
          key: elastic
    tls:
      # ECK generates a self-signed CA; set to true only if you mount the CA cert
      verify: false
    index: fluent-bit
    # Required for Elasticsearch 8.x — document type names were removed in ES 8
    suppressTypeName: "On"
    writeOperation: upsert
```

The `suppressTypeName: "On"` field is mandatory for Elasticsearch 8.x. Without it, Fluent Bit sends requests with a `_type` field that Elasticsearch 8 rejects, resulting in 400 errors that appear to be authentication failures because the error body is not always surfaced clearly in Fluent Bit logs.

```bash
kubectl apply -f cluster-output-es.yaml

# Watch for any errors in Fluent Bit pods after applying
kubectl logs -n fluent -l app.kubernetes.io/name=fluent-bit --tail=100 | grep -i error
```

## End-to-End Validation

With all components running, verify the full pipeline from log collection through to Elasticsearch indexing.

```bash
# Retrieve the elastic password for API calls
export ES_PASSWORD=$(kubectl get secret quickstart-es-elastic-user \
  -n es-operator \
  -o jsonpath='{.data.elastic}' | base64 --decode)

# Query Elasticsearch for the fluent-bit index using an ephemeral pod
# The ephemeral pod approach avoids exposing ES credentials outside the cluster
kubectl run curl-test \
  --rm -it \
  --restart=Never \
  --image=curlimages/curl \
  -n es-operator \
  -- curl -sk -u "elastic:${ES_PASSWORD}" \
  "https://quickstart-es-http.es-operator.svc:9200/_cat/indices?v"
```

The output should include a `fluent-bit` index with a non-zero document count:

```
health status index               uuid                   pri rep docs.count  ...
green  open   fluent-bit-2026.03.20  xK2f...  1   0   48293    ...
```

If the index is missing, check Fluent Bit pod logs for connection errors, verify the secrets are present in the `fluent` namespace, and confirm the `ClusterOutput` has the `fluentbit.fluent.io/enabled: "true"` label.

Open Kibana at `https://localhost:5601` (or the configured Ingress hostname). Navigate to **Stack Management > Data Views** and create a new data view targeting the `fluent-bit*` index pattern with `@timestamp` as the time field. Once saved, use **Discover** to query logs — filter by `kubernetes.namespace_name` for namespace-scoped views, or by `kubernetes.pod_name` to drill into a specific workload.

## Index Lifecycle Management: Preventing Disk Exhaustion

Without an Index Lifecycle Management (ILM) policy, every day's logs create a new Elasticsearch index that accumulates indefinitely. On a busy cluster logging 10 GB/day, a three-month deployment without ILM produces ~900 GB of indexes with no automated cleanup. ILM defines what happens to indexes over time: when to roll over to a new index (hot phase), when to compact and reduce shard count (warm phase), when to freeze (cold phase), and when to delete (delete phase).

### Configuring ILM via the Kibana UI

Navigate to **Stack Management > Index Lifecycle Policies** and click **Create policy**.

**Hot phase** — Define rollover conditions. For log data, rolling over when the primary shard exceeds 5 GB or the index reaches 7 days old keeps individual indexes at a manageable size:

- Enable rollover
- Maximum primary shard size: `5 GB`
- Maximum age: `7 days`
- Set priority: `100`

**Warm phase** — Enable after 14 days. Compact data to reduce storage and query overhead:

- Minimum age: `14 days`
- Shrink: number of shards: `1`
- Force merge: maximum number of segments: `1`
- Set priority: `50`

**Cold phase** — Enable after 30 days. Freeze the index to release heap memory; data is still queryable but reads are slower:

- Minimum age: `30 days`
- Enable freeze
- Set priority: `0`

**Delete phase** — Remove indexes after 90 days:

- Minimum age: `90 days`
- Enable delete

### Applying the Policy via API

For GitOps workflows, apply the ILM policy via the Elasticsearch API instead of the Kibana UI:

```bash
# Apply the ILM policy through an ephemeral pod to keep credentials in-cluster
kubectl run ilm-setup \
  --rm -it \
  --restart=Never \
  --image=curlimages/curl \
  -n es-operator \
  -- sh -c "curl -sk -u 'elastic:${ES_PASSWORD}' \
    -X PUT \
    -H 'Content-Type: application/json' \
    https://quickstart-es-http.es-operator.svc:9200/_ilm/policy/fluent-bit-policy \
    -d '{
      \"policy\": {
        \"phases\": {
          \"hot\": {
            \"min_age\": \"0ms\",
            \"actions\": {
              \"rollover\": {\"max_primary_shard_size\": \"5gb\", \"max_age\": \"7d\"},
              \"set_priority\": {\"priority\": 100}
            }
          },
          \"warm\": {
            \"min_age\": \"14d\",
            \"actions\": {
              \"shrink\": {\"number_of_shards\": 1},
              \"forcemerge\": {\"max_num_segments\": 1},
              \"set_priority\": {\"priority\": 50}
            }
          },
          \"cold\": {
            \"min_age\": \"30d\",
            \"actions\": {
              \"freeze\": {},
              \"set_priority\": {\"priority\": 0}
            }
          },
          \"delete\": {
            \"min_age\": \"90d\",
            \"actions\": {\"delete\": {}}
          }
        }
      }
    }'"
```

After creating the policy, attach it to the `fluent-bit` index template via **Stack Management > Index Management > Index Templates** in Kibana, setting `index.lifecycle.name` to `fluent-bit-policy` and `index.lifecycle.rollover_alias` to `fluent-bit`.

## Production Hardening Checklist

The development deployment covers the fundamentals. Promoting to production requires attention to several additional dimensions.

### PodDisruptionBudget for Elasticsearch Data Nodes

Kubernetes drain operations (during node upgrades or maintenance) can remove multiple Elasticsearch data pods simultaneously if no PDB is configured, triggering shard unavailability and potentially data loss:

```yaml
# pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: elasticsearch-data-pdb
  namespace: es-operator
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      # ECK applies this label automatically to all pods in a nodeSet
      elasticsearch.k8s.elastic.co/statefulset-name: logging-es-data
```

With `maxUnavailable: 1`, drain operations wait for a shard to be replicated before evicting the next pod. This extends node maintenance windows but eliminates the risk of data unavailability.

### Production Hardening Summary

| Item | Recommendation | Why |
|---|---|---|
| JVM heap | `requests == limits`, heap = 50% of limit | Guaranteed QoS, prevent OOM eviction |
| Replication | `number_of_replicas: 1` minimum | Survive one data node failure |
| Storage class | Use a storage class with `volumeBindingMode: WaitForFirstConsumer` | Ensures PVC lands on the same node as the pod |
| ILM policy | Hot rollover at 5 GB / 7 days; delete at 90 days | Prevent unbounded disk growth |
| PodDisruptionBudget | `maxUnavailable: 1` for data nodes | Safe node drain during maintenance |
| Anti-affinity | `requiredDuringSchedulingIgnoredDuringExecution` on `kubernetes.io/hostname` | Spread nodes across physical hosts |
| Network policy | Restrict Elasticsearch port 9200 to `fluent` and `es-operator` namespaces | Prevent unauthorized API access |
| Secret rotation | Use External Secrets Operator or CronJob to sync ECK-generated secret | Prevent stale credentials after ECK rotation |
| Kibana access | Ingress with TLS termination, not port-forward | Production availability |
| Resource limits on Fluent Bit | `limits.memory: 100Mi` minimum | Prevent log shipper from consuming node resources |

### RKE2-Specific Considerations

On RKE2 clusters, two common configuration points require attention:

**Storage class**: RKE2 ships with Local Path Provisioner as the default StorageClass (`local-path`). For Elasticsearch, use Longhorn (if installed) or a network-attached storage class instead. Local path storage is node-local and non-migratable — if an Elasticsearch pod is rescheduled to a different node, the PVC becomes inaccessible.

**`node.store.allow_mmap: false`**: RKE2 nodes typically have `vm.max_map_count` at the Linux default of 65536, below Elasticsearch's requirement of 262144. Setting `allow_mmap: false` in the Elasticsearch CRD bypasses the mmap requirement, using file I/O instead. This trades some search performance for compatibility without requiring privileged `initContainers` to adjust kernel parameters. For production clusters with high query load, use a DaemonSet to set `vm.max_map_count=262144` and remove `allow_mmap: false`.

## Troubleshooting Common Issues

| Symptom | Likely Cause | Diagnosis |
|---|---|---|
| Fluent Bit pod logs: `Connection refused` to port 9200 | Secret not copied to `fluent` namespace | `kubectl get secrets -n fluent \| grep elastic` |
| Fluent Bit logs: `400 Bad Request` from Elasticsearch | `suppressTypeName: "On"` missing in ClusterOutput | Check ClusterOutput spec; ES 8 requires this field |
| `fluent-bit` index not appearing in Kibana | `matchRegex` pattern matches nothing | Deploy stdout ClusterOutput first; verify log line format |
| Kibana stuck in `Connecting` state | Elasticsearch pods not yet `green` | `kubectl -n es-operator get elasticsearch` — wait for `green` |
| Elasticsearch pod OOMKilled | Heap > 50% of `limits.memory` | Reduce `ES_JAVA_OPTS` values; check `-Xmx` vs `limits.memory` |
| Disk utilization at 100% | No ILM policy configured | Apply ILM policy immediately; delete oldest indices manually first |
| ECK webhook blocking resource changes | Webhook pod unavailable | Set `failurePolicy: Ignore` in ECK operator values |
| Elasticsearch pod not scheduling | Anti-affinity rule with insufficient nodes | Reduce `count` or relax to `preferredDuringSchedulingIgnoredDuringExecution` |

For issues where Fluent Bit is running but no logs appear in Elasticsearch, the most efficient debugging workflow is:

1. Apply a `ClusterOutput` with `stdout` format and broad `matchRegex` to confirm collection is working
2. Check for errors in Fluent Bit pod logs with `kubectl logs -n fluent -l app.kubernetes.io/name=fluent-bit | grep -i "error\|warn"`
3. Verify the two secrets exist in the `fluent` namespace: `elastic-username` and `quickstart-es-elastic-user`
4. Check the Elasticsearch cluster health with the ephemeral curl pod — `/_cat/health?v` — to confirm it is accepting writes
5. Confirm the `ClusterOutput` has the `fluentbit.fluent.io/enabled: "true"` label

## Conclusion

Operator-managed EFK on Kubernetes eliminates the primary operational burdens of raw-manifest deployments: manual TLS management, unsafe rolling upgrades, ConfigMap editing for log routing changes, and ad-hoc disk cleanup scripts. ECK and Fluent Operator together provide a declarative, GitOps-compatible platform where the desired state of the entire logging stack is expressed in Kubernetes custom resources.

Key takeaways:

- **The heap sizing rule is non-negotiable**: set `ES_JAVA_OPTS` to exactly 50% of `limits.memory`, match `-Xms` and `-Xmx`, and never exceed 31 GB. Violations cause GC pauses or OOM evictions that corrupt in-flight index operations.
- **The cross-namespace secret copy is the most common silent failure**: copy `quickstart-es-elastic-user` from `es-operator` into `fluent` before debugging any Fluent Bit connectivity issue.
- **ILM is not optional in production**: without index lifecycle management, Elasticsearch disks fill silently until the cluster becomes read-only. Deploy ILM before going to production.
- **Use a stdout `ClusterOutput` first**: validating log collection independently of authentication complexity saves significant debugging time.
- **`requests == limits` for Elasticsearch pods**: Guaranteed QoS prevents kubelet eviction under memory pressure — critical for a stateful workload where eviction triggers shard re-replication.
