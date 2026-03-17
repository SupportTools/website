---
title: "Kubernetes Egress Control: NetworkPolicies, Egress Gateways, and DNS Filtering"
date: 2028-02-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Networking", "Egress", "NetworkPolicy", "Cilium", "Istio", "Security"]
categories:
- Kubernetes
- Networking
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to controlling outbound traffic from Kubernetes pods using NetworkPolicies, Istio egress gateways, Cilium egress IP, and DNS-based filtering with FQDN policies."
more_link: "yes"
url: "/kubernetes-network-egress-control-guide/"
---

Controlling egress traffic from Kubernetes workloads is one of the most frequently underimplemented aspects of cluster security. While teams invest heavily in ingress hardening, pods silently exfiltrate data, call unauthorized APIs, or phone home to malicious infrastructure through unrestricted outbound paths. A mature egress control strategy layers default-deny NetworkPolicies, dedicated egress gateways for auditability, DNS-based filtering to catch FQDN targets, and structured logging of every outbound connection.

This guide covers the complete egress control stack: Kubernetes NetworkPolicy egress rules, Cilium's FQDN and egress IP capabilities, Istio's egress gateway pattern, CoreDNS policy filtering, proxy-based egress for transparent interception, and audit logging pipelines that provide the visibility required for compliance workstreams.

<!--more-->

# Kubernetes Egress Control: NetworkPolicies, Egress Gateways, and DNS Filtering

## The Egress Threat Model

Before selecting controls, understanding the threat model clarifies which mechanisms to apply. Uncontrolled egress creates four primary risk categories:

**Data exfiltration**: Compromised workloads sending sensitive data to attacker-controlled endpoints. Without egress controls, any pod with network connectivity can reach arbitrary internet destinations.

**C2 beaconing**: Malware establishing command-and-control channels through permitted ports (80/443) to bypass coarse firewall rules.

**Dependency confusion**: Build tools or runtime processes fetching packages from unexpected registries when impersonated package names resolve to attacker infrastructure.

**Lateral movement via egress**: Pods reaching internal services outside their intended scope by exploiting the absence of east-west controls.

A layered egress architecture addresses all four categories through complementary mechanisms rather than a single control point.

## Layer 1: Default-Deny Egress with NetworkPolicies

The foundation of any egress control strategy is a default-deny policy applied at the namespace level. Kubernetes NetworkPolicies are enforced by the CNI plugin; verify that the cluster CNI supports NetworkPolicy enforcement before relying on them.

### Default-Deny Baseline

```yaml
# default-deny-egress.yaml
# Apply this to every namespace to establish a deny-all egress baseline.
# Pods in this namespace will have no outbound connectivity until
# explicit allow rules are added.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-egress
  namespace: production
  annotations:
    # Document the policy intent for operators
    policy.security/reason: "Baseline deny-all egress; explicit rules required"
    policy.security/owner: "platform-security@example.com"
spec:
  podSelector: {}        # Matches ALL pods in the namespace
  policyTypes:
  - Egress
  # No egress rules = deny all outbound traffic
```

```yaml
# default-deny-ingress-egress.yaml
# Combined deny for both directions; apply to new namespaces by default
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

### Allowing Essential System Traffic

After applying default-deny, pods lose DNS resolution and cluster-internal communication. Restore only what is needed:

```yaml
# allow-dns-egress.yaml
# Permit DNS queries to CoreDNS; required for all pod name resolution.
# Selector targets kube-dns pods across the cluster.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: production
spec:
  podSelector: {}          # All pods need DNS
  policyTypes:
  - Egress
  egress:
  - ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
    to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
```

```yaml
# allow-internal-egress.yaml
# Allow pods labeled app=api-server to reach the database tier
# within the same namespace and the shared-services namespace.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-to-database
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-server
  policyTypes:
  - Egress
  egress:
  # Same-namespace database pods
  - to:
    - podSelector:
        matchLabels:
          tier: database
    ports:
    - protocol: TCP
      port: 5432
  # Cross-namespace cache tier
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: shared-services
      podSelector:
        matchLabels:
          app: redis-cache
    ports:
    - protocol: TCP
      port: 6379
```

### Egress to External IP Ranges

For pods that must reach external services, use ipBlock rules with explicit CIDR ranges:

```yaml
# allow-external-api.yaml
# Permit the payment-service pods to reach the payment processor API.
# The /32 blocks limit scope to specific known IPs rather than broad ranges.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-payment-api-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: payment-service
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 203.0.113.10/32   # payment-api-primary.example.com
    - ipBlock:
        cidr: 203.0.113.11/32   # payment-api-secondary.example.com
    ports:
    - protocol: TCP
      port: 443
  # Always allow DNS for name resolution
  - ports:
    - protocol: UDP
      port: 53
    to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
```

### Verifying NetworkPolicy Enforcement

NetworkPolicies only work if the CNI enforces them. Validate enforcement with a test pod:

```bash
#!/bin/bash
# verify-egress-policy.sh
# Tests that default-deny-egress blocks outbound connectivity
# and that allow rules function as expected.

NAMESPACE="${1:-production}"

# Deploy a test pod
kubectl run egress-test \
  --namespace="${NAMESPACE}" \
  --image=nicolaka/netshoot \
  --rm \
  --restart=Never \
  --command -- sleep 300 &

sleep 5

# Test 1: External internet should be blocked
echo "=== Test: External internet (should timeout) ==="
kubectl exec -n "${NAMESPACE}" egress-test -- \
  curl --max-time 5 -s -o /dev/null -w "%{http_code}" https://example.com \
  && echo "FAIL: External traffic not blocked" \
  || echo "PASS: External traffic blocked"

# Test 2: DNS should work
echo "=== Test: DNS resolution ==="
kubectl exec -n "${NAMESPACE}" egress-test -- \
  nslookup kubernetes.default.svc.cluster.local \
  && echo "PASS: DNS working" \
  || echo "FAIL: DNS blocked"

# Test 3: Internal service (adjust for your environment)
echo "=== Test: Internal service ==="
kubectl exec -n "${NAMESPACE}" egress-test -- \
  curl --max-time 5 -s -o /dev/null -w "%{http_code}" \
  http://kubernetes.default.svc.cluster.local

# Cleanup
kubectl delete pod egress-test -n "${NAMESPACE}" --ignore-not-found
```

## Layer 2: Cilium Egress IP Gateway

Cilium extends standard NetworkPolicy with egress IP capabilities, enabling pods to appear to external systems as originating from a stable, auditable IP address. This is essential for firewall allowlisting on destination systems.

### Cilium CiliumEgressGatewayPolicy

```yaml
# cilium-egress-gateway-policy.yaml
# Routes all egress from the 'payment-service' workload through
# a dedicated gateway node that has the egress IP configured.
# External systems see only the egressGateway IP.
apiVersion: cilium.io/v2
kind: CiliumEgressGatewayPolicy
metadata:
  name: payment-service-egress
spec:
  # Select the pods whose egress traffic this policy controls
  selectors:
  - podSelector:
      matchLabels:
        app: payment-service
        environment: production

  # Destination: reach the payment processor CIDR via the gateway
  destinationCIDRs:
  - "203.0.113.0/24"   # Payment processor CIDR

  egressGateway:
    # nodeSelector identifies which node acts as the egress gateway
    nodeSelector:
      matchLabels:
        node-role.kubernetes.io/egress-gateway: "true"
    # The stable IP assigned to this gateway node's egress interface
    egressIP: "10.100.50.10"
```

### FQDN-Based Egress Policies

Cilium's FQDN policies resolve domain names dynamically and maintain IP sets, avoiding the brittle IP-based allowlists that break when CDN IPs rotate:

```yaml
# cilium-fqdn-policy.yaml
# Permits pods labeled app=data-exporter to reach specific FQDNs
# over HTTPS. Cilium resolves the FQDNs via DNS and builds
# dynamic IP sets from the responses.
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: data-exporter-fqdn-egress
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: data-exporter

  egress:
  # Allow HTTPS to specific FQDNs
  - toFQDNs:
    - matchName: "s3.amazonaws.com"
    - matchName: "sqs.us-east-1.amazonaws.com"
    - matchPattern: "*.s3.us-east-1.amazonaws.com"
    toPorts:
    - ports:
      - port: "443"
        protocol: TCP
      rules:
        http: []          # Enable L7 visibility for logging

  # Allow DNS queries through CoreDNS only
  - toEndpoints:
    - matchLabels:
        "k8s:io.kubernetes.pod.namespace": kube-system
        k8s-app: kube-dns
    toPorts:
    - ports:
      - port: "53"
        protocol: ANY
      rules:
        dns:
        - matchPattern: "*"  # Log all DNS queries for audit

  # Deny everything else by omission
```

### Cilium Egress Audit Logging

Configure Hubble (Cilium's observability component) to capture egress flows:

```yaml
# hubble-config.yaml
# Enable Hubble flow export for egress audit logging.
# Flows are exported to the Loki/Elasticsearch pipeline.
apiVersion: v1
kind: ConfigMap
metadata:
  name: cilium-config
  namespace: kube-system
data:
  # Enable Hubble with flow retention
  enable-hubble: "true"
  hubble-listen-address: ":4244"
  hubble-flow-buffer-size: "4096"

  # Export flows to external sink
  hubble-export-file-path: "/var/run/cilium/hubble/export.log"
  hubble-export-file-max-size-mb: "100"
  hubble-export-file-max-backups: "5"

  # Enable L7 visibility for HTTP/DNS/Kafka
  enable-l7-proxy: "true"
```

```bash
# Query Hubble for egress connections from a specific pod
# Useful for auditing and troubleshooting egress policies
hubble observe \
  --namespace production \
  --pod payment-service \
  --type trace \
  --protocol tcp \
  --verdict FORWARDED \
  --direction EGRESS \
  --output json \
  | jq '{
      src: .source.pod_name,
      dst_ip: .destination.ip_address,
      dst_port: .l4.TCP.destination_port,
      verdict: .verdict,
      timestamp: .time
    }'
```

## Layer 3: Istio Egress Gateway

Istio's egress gateway provides a centralized proxy through which all external outbound traffic flows. This enables TLS origination, mTLS verification, traffic policies, and detailed telemetry at a single chokepoint.

### Enabling Strict Egress in Istio

```yaml
# istio-meshconfig-egress.yaml
# Configure the mesh to block external traffic unless explicitly
# registered via ServiceEntry. REGISTRY_ONLY prevents pods from
# bypassing the egress gateway.
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: production-mesh
  namespace: istio-system
spec:
  meshConfig:
    # REGISTRY_ONLY: only traffic to registered services is allowed
    # ALLOW_ANY: permissive mode (default, not recommended for production)
    outboundTrafficPolicy:
      mode: REGISTRY_ONLY

    # Enable access logging for all outbound connections
    accessLogFile: "/dev/stdout"
    accessLogFormat: |
      {
        "timestamp": "%START_TIME%",
        "method": "%REQ(:METHOD)%",
        "path": "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%",
        "protocol": "%PROTOCOL%",
        "response_code": "%RESPONSE_CODE%",
        "bytes_sent": "%BYTES_SENT%",
        "duration": "%DURATION%",
        "upstream_host": "%UPSTREAM_HOST%",
        "downstream_remote_address": "%DOWNSTREAM_REMOTE_ADDRESS%"
      }
```

### ServiceEntry for External Services

```yaml
# serviceentry-external-api.yaml
# Register an external HTTPS API with the mesh.
# Without this ServiceEntry, pods cannot reach this host
# when outboundTrafficPolicy is REGISTRY_ONLY.
apiVersion: networking.istio.io/v1alpha3
kind: ServiceEntry
metadata:
  name: external-payment-api
  namespace: production
spec:
  hosts:
  - "api.payment-processor.example.com"
  ports:
  - number: 443
    name: https
    protocol: HTTPS
  location: MESH_EXTERNAL        # Indicates the service is outside the mesh
  resolution: DNS                # Resolve via DNS (not static IPs)
```

### Egress Gateway Configuration

```yaml
# egress-gateway.yaml
# Deploy a dedicated Istio egress gateway and route external
# traffic through it for centralized control and logging.
apiVersion: networking.istio.io/v1alpha3
kind: Gateway
metadata:
  name: istio-egressgateway
  namespace: istio-system
spec:
  selector:
    istio: egressgateway
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    tls:
      mode: PASSTHROUGH            # Pass TLS through; do not terminate
    hosts:
    - "api.payment-processor.example.com"
---
# VirtualService routes traffic from sidecar proxies to the egress gateway
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: payment-api-through-egress
  namespace: production
spec:
  hosts:
  - "api.payment-processor.example.com"
  gateways:
  - mesh                          # Applied when source is a sidecar (pod)
  - istio-system/istio-egressgateway  # Applied at the egress gateway
  tls:
  - match:
    - gateways:
      - mesh
      port: 443
      sniHosts:
      - "api.payment-processor.example.com"
    route:
    - destination:
        host: istio-egressgateway.istio-system.svc.cluster.local
        port:
          number: 443
  - match:
    - gateways:
      - istio-system/istio-egressgateway
      port: 443
      sniHosts:
      - "api.payment-processor.example.com"
    route:
    - destination:
        host: "api.payment-processor.example.com"
        port:
          number: 443
---
# DestinationRule applies client TLS settings on the egress gateway
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: egressgateway-payment-api
  namespace: istio-system
spec:
  host: istio-egressgateway.istio-system.svc.cluster.local
  subsets:
  - name: payment-api
    trafficPolicy:
      portLevelSettings:
      - port:
          number: 443
        tls:
          mode: ISTIO_MUTUAL     # mTLS between sidecar and egress gateway
```

### Restricting Egress Gateway Access

Use AuthorizationPolicy to ensure only specific services route through the egress gateway:

```yaml
# authz-egress-gateway.yaml
# Only pods with the service account 'payment-service' can
# send traffic through the egress gateway to payment APIs.
# All other pods are denied at the gateway.
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: restrict-egress-gateway-access
  namespace: istio-system
spec:
  selector:
    matchLabels:
      istio: egressgateway
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        # Workload identity of the permitted caller
        - "cluster.local/ns/production/sa/payment-service"
    to:
    - operation:
        hosts:
        - "api.payment-processor.example.com"
```

## Layer 4: DNS-Based Filtering with CoreDNS

DNS filtering intercepts queries before connections are established, providing earlier control than IP-based policies. CoreDNS can implement DNS firewall rules via the `firewall` plugin or through integration with external DNS RPZ feeds.

### CoreDNS Policy Plugin Configuration

```yaml
# coredns-configmap-firewall.yaml
# Extends the CoreDNS configuration with firewall rules.
# Domains in the blocklist resolve to NXDOMAIN, preventing
# connection establishment regardless of IP-level policies.
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

        # DNS firewall: block known malicious/unauthorized domains
        # Uses the 'acl' plugin for DNS query filtering
        acl {
            # Block queries from pods in 'restricted' namespaces
            # to social media and file-sharing domains
            block type A net 10.244.0.0/16 {
                domain dropbox.com
                domain drive.google.com
                domain wetransfer.com
                domain pastebin.com
            }
            # Allow all other queries
            allow
        }

        kubernetes cluster.local in-addr.arpa ip6.arpa {
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }

        # Forward non-cluster DNS to upstream resolvers
        forward . 8.8.8.8 8.8.4.4 {
            max_concurrent 1000
            prefer_udp
            # Log all forwarded queries for audit
            policy sequential
        }

        # Log all DNS queries for security monitoring
        log . {
            class all
        }

        cache 30
        loop
        reload
        loadbalance
    }
```

### DNS Audit Logging Pipeline

```yaml
# coredns-audit-daemonset.yaml
# Deploys a log forwarder alongside CoreDNS to ship DNS logs
# to the SIEM for analysis.
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: coredns-log-forwarder
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: coredns-log-forwarder
  template:
    metadata:
      labels:
        app: coredns-log-forwarder
    spec:
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      containers:
      - name: fluent-bit
        image: fluent/fluent-bit:2.2
        volumeMounts:
        - name: coredns-logs
          mountPath: /var/log/coredns
          readOnly: true
        - name: fluent-bit-config
          mountPath: /fluent-bit/etc
      volumes:
      - name: coredns-logs
        hostPath:
          path: /var/log/pods/kube-system_coredns-*/
      - name: fluent-bit-config
        configMap:
          name: coredns-fluent-bit-config
```

## Layer 5: Proxy-Based Transparent Egress

For environments that require deep packet inspection or application-layer filtering beyond what NetworkPolicy provides, a transparent proxy intercepts all outbound HTTP/HTTPS connections.

### Squid Proxy Deployment

```yaml
# squid-proxy-deployment.yaml
# Deploys Squid as a transparent forward proxy for HTTP/HTTPS egress.
# Pods route traffic through this proxy via environment variables
# or iptables-based transparent interception.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: egress-proxy
  namespace: egress-control
spec:
  replicas: 2
  selector:
    matchLabels:
      app: egress-proxy
  template:
    metadata:
      labels:
        app: egress-proxy
    spec:
      containers:
      - name: squid
        image: ubuntu/squid:5.7-23.04_edge
        ports:
        - containerPort: 3128     # Standard HTTP proxy port
          name: http-proxy
        - containerPort: 3129     # CONNECT/HTTPS proxy port
          name: https-proxy
        volumeMounts:
        - name: squid-config
          mountPath: /etc/squid
        - name: squid-logs
          mountPath: /var/log/squid
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
      volumes:
      - name: squid-config
        configMap:
          name: squid-config
      - name: squid-logs
        emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: egress-proxy
  namespace: egress-control
spec:
  selector:
    app: egress-proxy
  ports:
  - name: http-proxy
    port: 3128
    targetPort: 3128
  - name: https-proxy
    port: 3129
    targetPort: 3129
```

```
# squid.conf - ConfigMap content
# Squid proxy configuration for Kubernetes egress control

# Basic settings
http_port 3128
http_port 3129 intercept    # Transparent HTTPS interception

# Access control lists
acl localnet src 10.0.0.0/8        # Pod network CIDR
acl SSL_ports port 443
acl Safe_ports port 80
acl Safe_ports port 443
acl CONNECT method CONNECT

# Allowlisted destinations
acl allowed_sites dstdomain .amazonaws.com
acl allowed_sites dstdomain .gcr.io
acl allowed_sites dstdomain .docker.io
acl allowed_sites dstdomain api.payment-processor.example.com

# Deny everything not explicitly allowed
http_access deny !allowed_sites
http_access allow localnet allowed_sites
http_access deny all

# Logging: log all requests for audit
access_log /var/log/squid/access.log combined
cache_log /var/log/squid/cache.log

# Log format includes client IP, timestamp, method, URL, status
logformat combined %tl %6tr %>a %Ss/%03>Hs %<st %rm %ru %[un %Sh/%<a %mt
```

## Layer 6: Egress Audit Logging with Falco

Falco provides runtime security monitoring that detects anomalous egress patterns that static policies cannot catch:

```yaml
# falco-egress-rules.yaml
# Custom Falco rules for detecting suspicious egress connections.
# These rules fire when pods connect to unexpected destinations
# or exfiltrate unusually large data volumes.
- rule: Unexpected Outbound Network Connection
  desc: >
    A process established a network connection to an external IP
    that is not in the approved allowlist. This may indicate
    data exfiltration or C2 communication.
  condition: >
    outbound and
    not proc.name in (allowed_egress_processes) and
    not fd.sip.name in (allowed_external_domains) and
    not fd.sip startswith "10." and
    not fd.sip startswith "172.16." and
    not fd.sip startswith "192.168." and
    container and
    k8s.ns.name in (monitored_namespaces)
  output: >
    Unexpected outbound connection
    (pod=%k8s.pod.name
     namespace=%k8s.ns.name
     process=%proc.name
     destination=%fd.name
     container_image=%container.image.repository)
  priority: WARNING
  tags: [network, egress, exfiltration]

- rule: Large Data Egress
  desc: >
    A container sent more than 10MB to a single external connection.
    May indicate bulk data exfiltration.
  condition: >
    outbound and
    evt.type = sendto and
    evt.rawarg.res > 10485760 and    # 10MB threshold
    not fd.sip startswith "10." and
    container
  output: >
    Large data egress detected
    (pod=%k8s.pod.name
     namespace=%k8s.ns.name
     bytes=%evt.rawarg.res
     destination=%fd.sip)
  priority: CRITICAL
  tags: [network, egress, data-loss]

- list: allowed_egress_processes
  items: [curl, wget, python3, java, node]

- list: monitored_namespaces
  items: [production, staging, payment]
```

## Audit Logging Architecture

### Centralized Egress Log Pipeline

```yaml
# fluentbit-egress-pipeline.yaml
# Fluent Bit DaemonSet collects egress logs from multiple sources:
# - Cilium Hubble flows
# - Squid proxy access logs
# - Istio access logs
# - Falco alerts
# Ships to Elasticsearch for SIEM correlation.
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-egress-config
  namespace: logging
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         5
        Log_Level     info
        Daemon        off
        Parsers_File  parsers.conf

    # Cilium Hubble egress flows
    [INPUT]
        Name              tail
        Path              /var/run/cilium/hubble/export.log
        Parser            json
        Tag               cilium.egress
        Refresh_Interval  5

    # Squid proxy access logs
    [INPUT]
        Name              tail
        Path              /var/log/squid/access.log
        Parser            squid
        Tag               squid.access
        Refresh_Interval  5

    # Istio egress gateway access logs
    [INPUT]
        Name              tail
        Path              /var/log/istio/egress-access.log
        Parser            json
        Tag               istio.egress
        Refresh_Interval  5

    # Enrich all logs with cluster metadata
    [FILTER]
        Name         record_modifier
        Match        *
        Record       cluster_name ${CLUSTER_NAME}
        Record       environment ${ENVIRONMENT}

    # Route to Elasticsearch
    [OUTPUT]
        Name            es
        Match           *
        Host            elasticsearch.logging.svc.cluster.local
        Port            9200
        Index           egress-audit
        Type            _doc
        Logstash_Format On
        Logstash_Prefix egress-audit
        Time_Key        @timestamp
        Retry_Limit     5
```

### PromQL Queries for Egress Monitoring

```promql
# Rate of blocked egress connections per namespace
# High values indicate policy gaps or workload misconfiguration
sum by (namespace, policy_name) (
  rate(cilium_drop_count_total{reason="Policy denied", direction="egress"}[5m])
)

# Top destinations by connection count (Cilium metrics)
# Identifies unusual external connection patterns
topk(20,
  sum by (destination) (
    rate(hubble_flows_processed_total{
      type="trace",
      subtype="to-network",
      verdict="forwarded"
    }[1h])
  )
)

# DNS NXDOMAIN rate - elevated values indicate blocked queries
# and may indicate that a policy is too restrictive
rate(coredns_dns_responses_total{rcode="NXDOMAIN"}[5m])
```

## Compliance Mapping

### PCI DSS Requirement 1.3

PCI DSS Requirement 1.3 mandates restricting inbound and outbound traffic to only that which is necessary. The egress controls described in this guide map directly to these requirements:

| PCI Requirement | Control | Implementation |
|----------------|---------|----------------|
| 1.3.2 Restrict inbound to known states | Default-deny + explicit allow | NetworkPolicy |
| 1.3.3 Not pass spoofed source IPs | Egress IP gateway | Cilium EgressGatewayPolicy |
| 1.3.4 Do not allow unauthorized outbound | Default-deny egress | NetworkPolicy + Cilium FQDN |
| 1.3.6 Secure DMZ placement | Dedicated gateway node | Istio/Cilium gateway |

### Generating Compliance Evidence

```bash
#!/bin/bash
# generate-egress-compliance-report.sh
# Generates a compliance report documenting egress controls
# for audit purposes. Output is suitable for PCI/SOC2 evidence.

CLUSTER="${1:-production}"
REPORT_DATE=$(date +%Y-%m-%d)
REPORT_FILE="egress-compliance-report-${CLUSTER}-${REPORT_DATE}.json"

echo "Generating egress compliance report for cluster: ${CLUSTER}"

# Collect all NetworkPolicies with egress rules
kubectl get networkpolicies \
  --all-namespaces \
  -o json \
  | jq '[.items[] | select(.spec.policyTypes[] == "Egress")] | {
      report_date: "'"${REPORT_DATE}"'",
      cluster: "'"${CLUSTER}"'",
      total_egress_policies: length,
      policies_by_namespace: (group_by(.metadata.namespace) | map({
        namespace: .[0].metadata.namespace,
        policy_count: length,
        policy_names: [.[].metadata.name]
      }))
    }' > "${REPORT_FILE}"

# Check for namespaces without default-deny
echo "Namespaces missing default-deny-egress policy:"
kubectl get namespaces -o jsonpath='{.items[*].metadata.name}' \
  | tr ' ' '\n' \
  | while read ns; do
      policy_count=$(kubectl get networkpolicies -n "${ns}" \
        -o json 2>/dev/null \
        | jq '[.items[] | select(
            .spec.podSelector == {} and
            (.spec.policyTypes[]? == "Egress") and
            (.spec.egress == null or .spec.egress == [])
          )] | length')
      if [ "${policy_count}" -eq 0 ]; then
        echo "  MISSING: ${ns}"
      fi
    done

echo "Report saved to: ${REPORT_FILE}"
```

## Operational Runbook

### Debugging Unexpected Egress Blocks

```bash
#!/bin/bash
# debug-egress-block.sh
# Diagnoses why a pod cannot reach an expected destination.
# Run this when a service reports connection failures.

POD="${1}"
NAMESPACE="${2:-default}"
DESTINATION="${3}"

echo "=== Debugging egress from ${NAMESPACE}/${POD} to ${DESTINATION} ==="

# Step 1: Check applicable NetworkPolicies
echo ""
echo "--- NetworkPolicies affecting this pod ---"
kubectl get networkpolicies -n "${NAMESPACE}" -o json \
  | jq --arg pod "${POD}" '
      .items[] | select(
        .spec.podSelector.matchLabels as $labels |
        # This is a simplified check; production should use label matching
        .spec.policyTypes[] == "Egress"
      ) | {name: .metadata.name, egress: .spec.egress}
    '

# Step 2: Check Cilium policy for the pod
echo ""
echo "--- Cilium endpoint policy ---"
POD_ID=$(kubectl get pod "${POD}" -n "${NAMESPACE}" \
  -o jsonpath='{.metadata.uid}')
kubectl exec -n kube-system ds/cilium -- \
  cilium endpoint get \
  -o json 2>/dev/null \
  | jq --arg uid "${POD_ID}" \
    '.[] | select(.status.identity.labels[] | contains($uid)) |
     .status.policy.egress' 2>/dev/null || true

# Step 3: Check recent Cilium drops for this pod
echo ""
echo "--- Recent drops (last 60s) ---"
hubble observe \
  --namespace "${NAMESPACE}" \
  --pod "${POD}" \
  --verdict DROPPED \
  --direction EGRESS \
  --last 100 \
  --output json \
  2>/dev/null \
  | jq '{
      time: .time,
      destination: .destination.ip_address,
      port: .l4.TCP.destination_port,
      drop_reason: .drop_reason_desc
    }'

# Step 4: Check Istio for REGISTRY_ONLY blocks
echo ""
echo "--- Istio passthrough attempts ---"
kubectl logs \
  -n istio-system \
  -l app=istio-ingressgateway \
  --since=5m \
  2>/dev/null \
  | grep -i "BlackHoleCluster\|PassthroughCluster" \
  | tail -20
```

## Summary

A robust Kubernetes egress control architecture requires multiple coordinated layers. NetworkPolicy provides the deny-all baseline enforced by the CNI. Cilium's FQDN policies handle the dynamic nature of cloud service IPs. Istio's egress gateway centralizes HTTPS traffic for inspection and mTLS enforcement. DNS filtering in CoreDNS catches blocked domains before TCP connections are established. Proxy-based interception handles legacy HTTP traffic. Falco detects runtime anomalies that static policies miss.

The combination produces a defense-in-depth posture where a compromise at any single layer does not enable unrestricted egress. Audit logs from each layer feed into a central SIEM, providing the evidence trail required for PCI DSS, SOC 2, and other compliance frameworks.

Start with NetworkPolicy default-deny in each namespace. Add Cilium FQDN policies for cloud service dependencies. Route sensitive workloads through an Istio egress gateway. Enable Hubble and Falco for continuous monitoring. The result is an egress posture that provides both strong security controls and the operational visibility needed to manage them.
