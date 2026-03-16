---
title: "Enterprise Erlang Clustering in Kubernetes: Implementing Mutual TLS for Secure Distributed Systems"
date: 2026-06-27T00:00:00-05:00
draft: false
tags: ["Erlang", "Kubernetes", "Clustering", "mTLS", "Distributed-Systems", "Security", "cert-manager"]
categories: ["DevOps", "Security", "Container-Orchestration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying production-ready Erlang clusters in Kubernetes with mutual TLS authentication, automated certificate management, and enterprise security patterns."
more_link: "yes"
url: "/enterprise-erlang-clustering-kubernetes-mtls-security/"
---

Building fault-tolerant distributed systems requires robust clustering mechanisms that can handle network partitions, node failures, and security threats. Erlang's legendary clustering capabilities, combined with Kubernetes orchestration and modern certificate management, create a powerful foundation for enterprise-grade distributed applications. This comprehensive guide demonstrates how to implement secure Erlang clusters with mutual TLS authentication, automated certificate lifecycle management, and production-ready monitoring.

<!--more-->

## Executive Summary

Erlang's distributed computing model has powered mission-critical systems for decades, from telecommunications infrastructure to financial trading platforms. When deployed in Kubernetes environments, Erlang clusters require sophisticated security measures to protect inter-node communication and ensure data integrity across distributed nodes. This implementation guide covers enterprise patterns for deploying Erlang clusters with mutual TLS authentication, automated certificate provisioning, and comprehensive monitoring strategies.

## Understanding Erlang Distribution Architecture

### Core Clustering Concepts

Erlang's distribution mechanism relies on several key components that must be properly configured in containerized environments:

```erlang
% Node configuration in sys.config
[
 {kernel, [
  {inet_dist_listen_min, 9100},
  {inet_dist_listen_max, 9105},
  {inet_dist_use_interface, {0,0,0,0}},
  {inet_dist_address_resolver, inet_dns}
 ]},
 {ssl, [
  {session_cache_server_max, 20000},
  {session_cache_client_max, 5000},
  {ssl_pem_cache_clean, 300000}
 ]}
].
```

### Distribution Security Models

Traditional Erlang clustering relies on shared cookies for authentication, which presents security challenges in multi-tenant environments. Enterprise deployments require more sophisticated approaches:

1. **Cookie-based Authentication** - Simple but limited security
2. **TLS Distribution** - Encrypted communication channels
3. **Mutual TLS (mTLS)** - Certificate-based bidirectional authentication
4. **Certificate Authority Integration** - Automated certificate lifecycle management

## Kubernetes Infrastructure Prerequisites

### Namespace Configuration

Create a dedicated namespace with appropriate security policies and resource quotas:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: erlang-cluster
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: erlang-cluster-quota
  namespace: erlang-cluster
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "10"
    persistentvolumeclaims: "5"
```

### Network Policies

Implement microsegmentation with network policies to control inter-pod communication:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: erlang-cluster-policy
  namespace: erlang-cluster
spec:
  podSelector:
    matchLabels:
      app: erlang-cluster
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: erlang-cluster
    ports:
    - protocol: TCP
      port: 4369  # EPMD port
    - protocol: TCP
      port: 9100  # Distribution port start
    - protocol: TCP
      port: 9105  # Distribution port end
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
    ports:
    - protocol: TCP
      port: 8080  # HTTP metrics
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: erlang-cluster
    ports:
    - protocol: TCP
      port: 4369
    - protocol: TCP
      port: 9100
    - protocol: TCP
      port: 9105
  - to: []
    ports:
    - protocol: TCP
      port: 53   # DNS
    - protocol: UDP
      port: 53   # DNS
```

## Certificate Management with cert-manager

### Installing cert-manager

Deploy cert-manager with comprehensive configuration for enterprise environments:

```yaml
# cert-manager-values.yaml
installCRDs: true
replicaCount: 2

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        labelSelector:
          matchExpressions:
          - key: app.kubernetes.io/name
            operator: In
            values:
            - cert-manager
        topologyKey: kubernetes.io/hostname

prometheus:
  enabled: true
  servicemonitor:
    enabled: true
    prometheusInstance: default

webhook:
  replicaCount: 2
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi

cainjector:
  replicaCount: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
```

Install using Helm:

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.13.2 \
  --values cert-manager-values.yaml \
  --wait
```

### Creating Certificate Authority

Establish a private CA for internal cluster communication:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: erlang-ca-key-pair
  namespace: cert-manager
type: Opaque
data:
  tls.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...  # Base64 encoded CA cert
  tls.key: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t...   # Base64 encoded CA key
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: erlang-ca-issuer
spec:
  ca:
    secretName: erlang-ca-key-pair
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: erlang-selfsigned-issuer
spec:
  selfSigned: {}
```

### Automated Certificate Provisioning

Create certificate templates for Erlang nodes:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: erlang-server-cert
  namespace: erlang-cluster
spec:
  secretName: erlang-server-tls
  issuerRef:
    name: erlang-ca-issuer
    kind: ClusterIssuer
  commonName: erlang-cluster.erlang-cluster.svc.cluster.local
  dnsNames:
  - erlang-cluster.erlang-cluster.svc.cluster.local
  - "*.erlang-cluster.erlang-cluster.svc.cluster.local"
  - erlang-cluster-0.erlang-cluster.erlang-cluster.svc.cluster.local
  - erlang-cluster-1.erlang-cluster.erlang-cluster.svc.cluster.local
  - erlang-cluster-2.erlang-cluster.erlang-cluster.svc.cluster.local
  ipAddresses:
  - 127.0.0.1
  keyAlgorithm: rsa
  keySize: 4096
  duration: 8760h  # 1 year
  renewBefore: 720h  # 30 days
  privateKey:
    algorithm: RSA
    size: 4096
  usages:
  - digital signature
  - key encipherment
  - server auth
  - client auth
```

## Erlang Application Configuration

### Dockerfile with Security Hardening

Create a secure container image with non-root user and minimal attack surface:

```dockerfile
FROM erlang:26-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    git \
    build-base \
    openssl-dev

# Create build user
RUN addgroup -g 1001 builder && \
    adduser -D -u 1001 -G builder builder

USER builder
WORKDIR /app

# Copy source code
COPY --chown=builder:builder . .

# Build release
RUN rebar3 as prod release

FROM alpine:3.18 AS runtime

# Install runtime dependencies
RUN apk add --no-cache \
    openssl \
    ncurses-libs \
    libcrypto3 \
    libssl3 && \
    apk add --no-cache --repository=http://dl-cdn.alpinelinux.org/alpine/edge/community \
    libstdc++

# Create runtime user
RUN addgroup -g 1001 erlang && \
    adduser -D -u 1001 -G erlang erlang

# Create necessary directories
RUN mkdir -p /app/certs /app/logs /app/data && \
    chown -R erlang:erlang /app

USER erlang
WORKDIR /app

# Copy release
COPY --from=builder --chown=erlang:erlang /app/_build/prod/rel/erlang_cluster .

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["./bin/erlang_cluster", "ping"]

EXPOSE 4369 8080 9100-9105

ENTRYPOINT ["./bin/erlang_cluster"]
CMD ["foreground"]
```

### Application Configuration

Configure Erlang distribution with TLS support:

```erlang
%% sys.config
[
 {kernel, [
  %% Distribution configuration
  {inet_dist_listen_min, 9100},
  {inet_dist_listen_max, 9105},
  {inet_dist_use_interface, {0,0,0,0}},
  {inet_dist_address_resolver, inet_dns},

  %% Enable TLS distribution
  {proto_dist, inet_tls},

  %% TLS distribution options
  {inet_tls_dist, [
   {server_certfile, "/app/certs/tls.crt"},
   {server_keyfile, "/app/certs/tls.key"},
   {server_cacertfile, "/app/certs/ca.crt"},
   {client_certfile, "/app/certs/tls.crt"},
   {client_keyfile, "/app/certs/tls.key"},
   {client_cacertfile, "/app/certs/ca.crt"},
   {verify, verify_peer},
   {secure_renegotiate, true},
   {reuse_sessions, true},
   {honor_cipher_order, true},
   {ciphers, [
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256"
   ]},
   {versions, ['tlsv1.3', 'tlsv1.2']},
   {depth, 2}
  ]}
 ]},

 {ssl, [
  {session_cache_server_max, 20000},
  {session_cache_client_max, 5000},
  {ssl_pem_cache_clean, 300000}
 ]},

 {sasl, [
  {sasl_error_logger, false}
 ]},

 {logger, [
  {handler, default, logger_std_h, #{
   level => info,
   config => #{
    file => "/app/logs/erlang_cluster.log",
    max_no_bytes => 10485760,  % 10MB
    max_no_files => 5,
    compress_on_rotate => true
   },
   formatter => {logger_formatter, #{
    single_line => true,
    time_designator => $\s,
    template => [time, " [", level, "] ", pid, " ", msg, "\n"]
   }}
  }}
 ]}
].
```

### VM Arguments Configuration

Optimize the Erlang VM for containerized deployment:

```bash
# vm.args
-name erlang@${POD_NAME}.erlang-cluster.${NAMESPACE}.svc.cluster.local
-setcookie ${ERLANG_COOKIE}

## Heartbeat management; auto-restarts VM if it dies or becomes unresponsive
-heart -env ERL_CRASH_DUMP_BYTES 0

## Enable kernel poll and higher limits
+K true
+A 64
+hms 8192
+hmbs 8192
+zdbbl 128000

## Memory management
+MBas aobf
+MBlmbcs 512
+MBmmbcs 512
+MBsbct 75

## I/O system optimization
+IOp 8
+IOt 8

## Network buffer optimization
+zdbbl 32768

## Scheduler optimization
+S 4:4
+swt low
+spp true

## Memory optimization for containers
+MHacul de
+MEAacul de

## Crash dump settings
-env ERL_CRASH_DUMP /app/logs/erl_crash.dump
-env ERL_CRASH_DUMP_BYTES 104857600  # 100MB limit

## SSL/TLS optimization
+ssl_dist_optfile /app/config/inet_tls_dist.conf
```

## StatefulSet Deployment Configuration

### Core StatefulSet Manifest

Deploy Erlang cluster as a StatefulSet for stable network identities:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: erlang-cluster
  namespace: erlang-cluster
  labels:
    app: erlang-cluster
spec:
  serviceName: erlang-cluster
  replicas: 3
  selector:
    matchLabels:
      app: erlang-cluster
  template:
    metadata:
      labels:
        app: erlang-cluster
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        runAsGroup: 1001
        fsGroup: 1001
        fsGroupChangePolicy: "OnRootMismatch"
        seccompProfile:
          type: RuntimeDefault

      serviceAccountName: erlang-cluster

      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - erlang-cluster
              topologyKey: kubernetes.io/hostname

      initContainers:
      - name: cert-copier
        image: alpine:3.18
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1001
        command:
        - sh
        - -c
        - |
          cp /tmp/certs/* /app/certs/
          chmod 600 /app/certs/tls.key
          chmod 644 /app/certs/tls.crt
          chmod 644 /app/certs/ca.crt
        volumeMounts:
        - name: certs-temp
          mountPath: /tmp/certs
          readOnly: true
        - name: certs
          mountPath: /app/certs

      containers:
      - name: erlang-cluster
        image: erlang-cluster:1.0.0
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 1001

        env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: ERLANG_COOKIE
          valueFrom:
            secretKeyRef:
              name: erlang-cookie
              key: cookie
        - name: ERL_EPMD_PORT
          value: "4369"
        - name: RELX_REPLACE_OS_VARS
          value: "true"

        ports:
        - name: epmd
          containerPort: 4369
          protocol: TCP
        - name: http
          containerPort: 8080
          protocol: TCP
        - name: dist-start
          containerPort: 9100
          protocol: TCP
        - name: dist-end
          containerPort: 9105
          protocol: TCP

        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi

        livenessProbe:
          exec:
            command:
            - /app/bin/erlang_cluster
            - ping
          initialDelaySeconds: 60
          periodSeconds: 30
          timeoutSeconds: 10
          failureThreshold: 3

        readinessProbe:
          httpGet:
            path: /health
            port: 8080
            scheme: HTTP
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3

        volumeMounts:
        - name: certs
          mountPath: /app/certs
          readOnly: true
        - name: logs
          mountPath: /app/logs
        - name: data
          mountPath: /app/data
        - name: tmp
          mountPath: /tmp

      volumes:
      - name: certs-temp
        secret:
          secretName: erlang-server-tls
          defaultMode: 0644
      - name: certs
        emptyDir:
          medium: Memory
      - name: logs
        emptyDir: {}
      - name: tmp
        emptyDir: {}

  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 10Gi
```

### Service Configuration

Create headless service for cluster discovery:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: erlang-cluster
  namespace: erlang-cluster
  labels:
    app: erlang-cluster
spec:
  clusterIP: None
  selector:
    app: erlang-cluster
  ports:
  - name: epmd
    port: 4369
    targetPort: 4369
    protocol: TCP
  - name: http
    port: 8080
    targetPort: 8080
    protocol: TCP
  - name: dist-start
    port: 9100
    targetPort: 9100
    protocol: TCP
  - name: dist-end
    port: 9105
    targetPort: 9105
    protocol: TCP
---
apiVersion: v1
kind: Service
metadata:
  name: erlang-cluster-lb
  namespace: erlang-cluster
  labels:
    app: erlang-cluster
spec:
  type: ClusterIP
  selector:
    app: erlang-cluster
  ports:
  - name: http
    port: 8080
    targetPort: 8080
    protocol: TCP
```

## Monitoring and Observability

### Prometheus ServiceMonitor

Configure comprehensive metrics collection:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: erlang-cluster
  namespace: erlang-cluster
  labels:
    app: erlang-cluster
spec:
  selector:
    matchLabels:
      app: erlang-cluster
  endpoints:
  - port: http
    path: /metrics
    interval: 30s
    scrapeTimeout: 10s
    metricRelabelings:
    - sourceLabels: [__name__]
      regex: 'erlang_vm_.*'
      targetLabel: __name__
      replacement: '${1}'
    - sourceLabels: [instance]
      targetLabel: pod
      regex: '([^:]+):.*'
      replacement: '${1}'
```

### Grafana Dashboard

Create comprehensive monitoring dashboard:

```json
{
  "dashboard": {
    "title": "Erlang Cluster Monitoring",
    "tags": ["erlang", "clustering", "distributed-systems"],
    "panels": [
      {
        "title": "Cluster Nodes",
        "type": "stat",
        "targets": [
          {
            "expr": "count(up{job=\"erlang-cluster\"} == 1)",
            "legendFormat": "Active Nodes"
          }
        ]
      },
      {
        "title": "VM Memory Usage",
        "type": "graph",
        "targets": [
          {
            "expr": "erlang_vm_memory_total_bytes{job=\"erlang-cluster\"}",
            "legendFormat": "{{pod}} - Total"
          },
          {
            "expr": "erlang_vm_memory_processes_bytes{job=\"erlang-cluster\"}",
            "legendFormat": "{{pod}} - Processes"
          }
        ]
      },
      {
        "title": "Process Count",
        "type": "graph",
        "targets": [
          {
            "expr": "erlang_vm_process_count{job=\"erlang-cluster\"}",
            "legendFormat": "{{pod}} - Processes"
          }
        ]
      },
      {
        "title": "Distribution Connections",
        "type": "graph",
        "targets": [
          {
            "expr": "erlang_vm_dist_node_queue_size_bytes{job=\"erlang-cluster\"}",
            "legendFormat": "{{pod}} - {{node}} Queue Size"
          }
        ]
      }
    ]
  }
}
```

## Security Hardening and Compliance

### Pod Security Standards

Implement comprehensive security policies:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: erlang-cluster
  namespace: erlang-cluster
automountServiceAccountToken: false
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: erlang-cluster
  namespace: erlang-cluster
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["services", "endpoints"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: erlang-cluster
  namespace: erlang-cluster
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: erlang-cluster
subjects:
- kind: ServiceAccount
  name: erlang-cluster
  namespace: erlang-cluster
```

### Certificate Rotation Automation

Implement automated certificate rotation:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: certificate-rotation-checker
  namespace: erlang-cluster
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cert-rotation
          containers:
          - name: cert-checker
            image: alpine/k8s:1.28.2
            command:
            - sh
            - -c
            - |
              # Check certificate expiration
              CERT_EXPIRY=$(kubectl get certificate erlang-server-cert -n erlang-cluster -o jsonpath='{.status.notAfter}')
              CURRENT_TIME=$(date +%s)
              EXPIRY_TIME=$(date -d "$CERT_EXPIRY" +%s)
              DAYS_UNTIL_EXPIRY=$(( (EXPIRY_TIME - CURRENT_TIME) / 86400 ))

              if [ $DAYS_UNTIL_EXPIRY -lt 30 ]; then
                echo "Certificate expires in $DAYS_UNTIL_EXPIRY days, triggering renewal"
                kubectl annotate certificate erlang-server-cert -n erlang-cluster \
                  cert-manager.io/force-renew=$(date +%s)

                # Rolling restart of StatefulSet
                kubectl rollout restart statefulset/erlang-cluster -n erlang-cluster
              fi
          restartPolicy: OnFailure
```

## Production Deployment Patterns

### Multi-Environment Configuration

Structure configurations for different environments:

```yaml
# environments/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
- ../../base

patchesStrategicMerge:
- statefulset-patch.yaml
- configmap-patch.yaml

configMapGenerator:
- name: erlang-cluster-config
  behavior: merge
  literals:
  - ENVIRONMENT=production
  - LOG_LEVEL=info
  - METRICS_ENABLED=true

replicas:
- name: erlang-cluster
  count: 5

images:
- name: erlang-cluster
  newTag: "v1.2.3"
```

### Disaster Recovery Procedures

Implement comprehensive backup and recovery:

```bash
#!/bin/bash
# backup-erlang-cluster.sh

NAMESPACE="erlang-cluster"
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/backups/erlang-cluster-${BACKUP_DATE}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup persistent volumes
for pvc in $(kubectl get pvc -n $NAMESPACE -o name); do
  PVC_NAME=$(echo $pvc | cut -d'/' -f2)

  # Create snapshot job
  cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: backup-${PVC_NAME}-${BACKUP_DATE}
  namespace: $NAMESPACE
spec:
  template:
    spec:
      containers:
      - name: backup
        image: alpine:3.18
        command:
        - sh
        - -c
        - |
          tar czf /backup/${PVC_NAME}.tar.gz -C /data .
        volumeMounts:
        - name: data
          mountPath: /data
        - name: backup
          mountPath: /backup
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: $PVC_NAME
      - name: backup
        hostPath:
          path: $BACKUP_DIR
      restartPolicy: Never
  backoffLimit: 3
EOF
done

# Backup configuration
kubectl get configmap,secret,certificate -n $NAMESPACE -o yaml > "$BACKUP_DIR/config-backup.yaml"

echo "Backup completed in $BACKUP_DIR"
```

## Troubleshooting and Operations

### Common Issues and Solutions

**Node Discovery Problems:**
```bash
# Check EPMD connectivity
kubectl exec -it erlang-cluster-0 -n erlang-cluster -- epmd -names

# Verify DNS resolution
kubectl exec -it erlang-cluster-0 -n erlang-cluster -- \
  nslookup erlang-cluster-1.erlang-cluster.erlang-cluster.svc.cluster.local

# Test distribution port connectivity
kubectl exec -it erlang-cluster-0 -n erlang-cluster -- \
  nc -zv erlang-cluster-1.erlang-cluster.erlang-cluster.svc.cluster.local 9100
```

**Certificate Validation Issues:**
```bash
# Verify certificate details
kubectl exec -it erlang-cluster-0 -n erlang-cluster -- \
  openssl x509 -in /app/certs/tls.crt -text -noout

# Check certificate chain
kubectl exec -it erlang-cluster-0 -n erlang-cluster -- \
  openssl verify -CAfile /app/certs/ca.crt /app/certs/tls.crt

# Test TLS connection
kubectl exec -it erlang-cluster-0 -n erlang-cluster -- \
  openssl s_client -connect erlang-cluster-1.erlang-cluster.erlang-cluster.svc.cluster.local:9100 \
  -cert /app/certs/tls.crt -key /app/certs/tls.key -CAfile /app/certs/ca.crt
```

### Performance Tuning

Monitor and optimize cluster performance:

```erlang
%% Performance monitoring module
-module(cluster_monitor).
-export([node_metrics/0, connection_stats/0]).

node_metrics() ->
    #{
        processes => erlang:system_info(process_count),
        memory => erlang:memory(),
        schedulers => erlang:system_info(schedulers),
        reductions => element(1, erlang:statistics(reductions)),
        runtime => element(1, erlang:statistics(runtime)),
        wall_clock => element(1, erlang:statistics(wall_clock)),
        io => erlang:statistics(io),
        garbage_collection => erlang:statistics(garbage_collection)
    }.

connection_stats() ->
    Nodes = nodes(),
    lists:map(fun(Node) ->
        case net_adm:ping(Node) of
            pong ->
                {Node, connected, net_kernel:node_info(Node)};
            pang ->
                {Node, disconnected, undefined}
        end
    end, Nodes).
```

## Conclusion

Deploying secure Erlang clusters in Kubernetes requires careful attention to certificate management, network security, and operational monitoring. This implementation provides a foundation for production-ready distributed systems with mutual TLS authentication, automated certificate lifecycle management, and comprehensive observability.

Key benefits of this approach include:

- **Enhanced Security**: Mutual TLS provides strong authentication and encryption
- **Operational Excellence**: Automated certificate rotation and comprehensive monitoring
- **Scalability**: Kubernetes orchestration enables elastic scaling
- **Reliability**: Health checks and rolling updates ensure high availability
- **Compliance**: Security policies and audit trails meet enterprise requirements

The patterns demonstrated here can be adapted for various distributed applications beyond Erlang, providing a template for secure, scalable microservice architectures in Kubernetes environments.

Regular security audits, performance testing, and disaster recovery exercises ensure the continued effectiveness of this implementation in production environments. Consider implementing additional security measures such as service mesh integration, network scanning, and runtime security monitoring for enhanced protection in high-security environments.