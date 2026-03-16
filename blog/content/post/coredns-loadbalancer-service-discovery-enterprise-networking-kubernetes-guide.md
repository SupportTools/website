---
title: "Enterprise LoadBalancer DNS with CoreDNS: Advanced Service Discovery and Network Architecture for Kubernetes Production Environments"
date: 2026-05-27T00:00:00-05:00
draft: false
tags: ["CoreDNS", "Kubernetes", "LoadBalancer", "DNS", "ServiceDiscovery", "Networking", "Enterprise"]
categories: ["Networking", "Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing enterprise-grade LoadBalancer DNS with CoreDNS, featuring advanced service discovery patterns, high availability configurations, and production networking strategies for Kubernetes environments."
more_link: "yes"
url: "/coredns-loadbalancer-service-discovery-enterprise-networking-kubernetes-guide/"
---

CoreDNS serves as the cornerstone of modern Kubernetes networking, providing sophisticated DNS resolution and service discovery capabilities that enable enterprise-grade LoadBalancer implementations. This comprehensive guide demonstrates advanced CoreDNS deployment patterns, custom service discovery architectures, and production-ready networking strategies for large-scale Kubernetes environments.

<!--more-->

# Executive Summary

Enterprise Kubernetes environments require sophisticated DNS resolution strategies that go beyond basic service discovery. CoreDNS provides the flexibility and performance needed to implement advanced LoadBalancer DNS patterns, custom domain routing, and enterprise networking architectures. This guide presents production-ready configurations, high availability patterns, and operational best practices for implementing CoreDNS in complex enterprise environments.

## CoreDNS Architecture and LoadBalancer Integration

### Core DNS Resolution Architecture

CoreDNS operates as a plugin-based DNS server that provides flexible, programmable DNS resolution capabilities for Kubernetes environments:

```yaml
# Enterprise CoreDNS deployment for LoadBalancer DNS
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns-loadbalancer
  namespace: dns-system
  labels:
    app: coredns-lb
    tier: infrastructure
spec:
  replicas: 3
  selector:
    matchLabels:
      app: coredns-lb
  template:
    metadata:
      labels:
        app: coredns-lb
    spec:
      serviceAccountName: coredns-lb

      # Anti-affinity for high availability
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: coredns-lb
              topologyKey: kubernetes.io/hostname

      # Security context
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000

      containers:
      - name: coredns
        image: coredns/coredns:1.10.1
        imagePullPolicy: IfNotPresent

        # Resource allocation for enterprise workloads
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 1000m
            memory: 512Mi

        # Security configuration
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            add:
            - NET_BIND_SERVICE
            drop:
            - all
          readOnlyRootFilesystem: true

        # Health checks
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
            scheme: HTTP
          initialDelaySeconds: 60
          timeoutSeconds: 5
          successThreshold: 1
          failureThreshold: 5

        readinessProbe:
          httpGet:
            path: /ready
            port: 8181
            scheme: HTTP
          initialDelaySeconds: 10
          timeoutSeconds: 5
          successThreshold: 1
          failureThreshold: 3

        # Configuration and data volumes
        volumeMounts:
        - name: config-volume
          mountPath: /etc/coredns
          readOnly: true
        - name: hosts-volume
          mountPath: /etc/coredns/hosts
          readOnly: true
        - name: tmp
          mountPath: /tmp

        # Port configuration
        ports:
        - containerPort: 53
          name: dns
          protocol: UDP
        - containerPort: 53
          name: dns-tcp
          protocol: TCP
        - containerPort: 9153
          name: metrics
          protocol: TCP

        # Arguments
        args:
        - -conf
        - /etc/coredns/Corefile

      volumes:
      - name: config-volume
        configMap:
          name: coredns-lb-config
          items:
          - key: Corefile
            path: Corefile
      - name: hosts-volume
        configMap:
          name: coredns-lb-hosts
          items:
          - key: NodeHosts
            path: NodeHosts
      - name: tmp
        emptyDir: {}

      # DNS policy for enterprise environments
      dnsPolicy: Default
      dnsConfig:
        options:
        - name: ndots
          value: "2"
        - name: edns0
```

### Advanced CoreDNS Configuration

```yaml
# CoreDNS configuration for LoadBalancer DNS
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-lb-config
  namespace: dns-system
data:
  Corefile: |
    # Enterprise LoadBalancer DNS configuration
    (common) {
        errors
        log {
            class error
        }
        health {
            lameduck 5s
        }
        ready
        prometheus :9153
        cache 300 {
            success 9984 30
            denial 9984 5
            prefetch 10 60s 30%
        }
        reload 10s
        loadbalance round_robin
    }

    # Internal Kubernetes cluster DNS
    cluster.local:53 {
        import common
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        forward . /etc/resolv.conf {
            max_concurrent 1000
            policy sequential
        }
    }

    # Enterprise domain LoadBalancer resolution
    company.internal:53 {
        import common
        hosts /etc/coredns/hosts/NodeHosts {
            ttl 60
            reload 15s
            fallthrough
        }
        file /etc/coredns/db.company.internal company.internal {
            reload 30s
        }
        forward . 192.168.1.10 192.168.1.11 {
            max_concurrent 1000
            policy sequential
            health_check 10s
        }
    }

    # External LoadBalancer domains
    lb.company.com:53 {
        import common
        hosts /etc/coredns/hosts/NodeHosts {
            ttl 30
            reload 10s
            fallthrough
        }
        template IN A lb.company.com {
            match "^(.+)\.lb\.company\.com\.$"
            answer "{{ .Name }} 300 IN A {{ .Group 1 | service_ip }}"
            fallthrough
        }
        forward . 8.8.8.8 1.1.1.1 {
            max_concurrent 1000
            policy sequential
            health_check 5s
        }
    }

    # Geographic LoadBalancer routing
    us-east.company.com:53 {
        import common
        template IN A {
            match "^(.+)\.us-east\.company\.com\.$"
            answer "{{ .Name }} 60 IN A {{ index (split (index (service (printf \"%s.default\" (.Group 1))) \"loadBalancer\" \"ingress\") 0) \"ip\" }}"
            fallthrough
        }
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
            endpoint_pod_names
        }
    }

    # Fallback DNS
    .:53 {
        import common
        forward . /etc/resolv.conf {
            max_concurrent 1000
            policy sequential
            health_check 30s
        }
    }
---
# LoadBalancer host mappings
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-lb-hosts
  namespace: dns-system
data:
  NodeHosts: |
    # Static LoadBalancer mappings
    10.100.1.100 api.company.internal api-lb.company.internal
    10.100.1.101 web.company.internal web-lb.company.internal
    10.100.1.102 app.company.internal app-lb.company.internal

    # Geographic load balancers
    10.100.2.100 api.us-east.company.com
    10.100.2.101 web.us-east.company.com
    10.100.3.100 api.us-west.company.com
    10.100.3.101 web.us-west.company.com

    # Environment-specific endpoints
    10.100.4.100 api.staging.company.internal
    10.100.4.101 web.staging.company.internal
    10.100.5.100 api.production.company.internal
    10.100.5.101 web.production.company.internal
```

### Service Configuration for LoadBalancer Access

```yaml
# CoreDNS LoadBalancer service
apiVersion: v1
kind: Service
metadata:
  name: coredns-loadbalancer
  namespace: dns-system
  labels:
    app: coredns-lb
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9153"
    prometheus.io/path: "/metrics"
spec:
  type: NodePort
  ports:
  - name: dns-udp
    port: 53
    targetPort: 53
    protocol: UDP
    nodePort: 32053
  - name: dns-tcp
    port: 53
    targetPort: 53
    protocol: TCP
    nodePort: 32054
  - name: metrics
    port: 9153
    targetPort: 9153
    protocol: TCP
  selector:
    app: coredns-lb

---
# Internal cluster service
apiVersion: v1
kind: Service
metadata:
  name: coredns-lb-internal
  namespace: dns-system
spec:
  type: ClusterIP
  ports:
  - name: dns-udp
    port: 53
    targetPort: 53
    protocol: UDP
  - name: dns-tcp
    port: 53
    targetPort: 53
    protocol: TCP
  selector:
    app: coredns-lb
```

## High Availability and Geographic Distribution

### Multi-Region LoadBalancer Architecture

```yaml
# Multi-region CoreDNS deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns-lb-east
  namespace: dns-system
  labels:
    app: coredns-lb
    region: us-east
spec:
  replicas: 3
  selector:
    matchLabels:
      app: coredns-lb
      region: us-east
  template:
    metadata:
      labels:
        app: coredns-lb
        region: us-east
    spec:
      serviceAccountName: coredns-lb

      # Region-specific node placement
      nodeSelector:
        topology.kubernetes.io/region: us-east-1

      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: coredns-lb
                region: us-east
            topologyKey: kubernetes.io/hostname

      containers:
      - name: coredns
        image: coredns/coredns:1.10.1
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 2000m
            memory: 1Gi

        env:
        - name: REGION
          value: "us-east"
        - name: DATACENTER
          value: "us-east-1a"

        volumeMounts:
        - name: config-volume
          mountPath: /etc/coredns
          readOnly: true
        - name: regional-config
          mountPath: /etc/coredns/regional
          readOnly: true

      volumes:
      - name: config-volume
        configMap:
          name: coredns-lb-config
      - name: regional-config
        configMap:
          name: coredns-lb-east-config

---
# Regional configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-lb-east-config
  namespace: dns-system
data:
  regional.hosts: |
    # US East region specific mappings
    10.200.1.100 api.us-east.company.com
    10.200.1.101 web.us-east.company.com
    10.200.1.102 app.us-east.company.com

    # Failover endpoints
    10.200.2.100 api-failover.us-east.company.com
    10.200.2.101 web-failover.us-east.company.com
```

### Health Check and Failover Configuration

```yaml
# CoreDNS health monitoring
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-health-config
  namespace: dns-system
data:
  health.conf: |
    health.company.internal:53 {
        health {
            lameduck 10s
        }
        template IN A {
            match "^health\.company\.internal\.$"
            answer "health.company.internal 30 IN A 127.0.0.1"
        }
        template IN TXT {
            match "^status\.company\.internal\.$"
            answer "status.company.internal 30 IN TXT \"CoreDNS LoadBalancer Healthy - {{ env \"HOSTNAME\" }}\""
        }
    }

  Corefile: |
    # Health check endpoint
    health.company.internal:53 {
        errors
        log
        health {
            lameduck 10s
        }
        ready
        template IN A health.company.internal {
            answer "health.company.internal 30 IN A 127.0.0.1"
        }
        template IN TXT status.company.internal {
            answer "status.company.internal 30 IN TXT \"{{ env \"HOSTNAME\" }} - {{ now.Format \"2006-01-02T15:04:05Z\" }}\""
        }
    }

    # LoadBalancer health checks
    lb-health.company.internal:53 {
        errors
        health
        template IN A {
            match "^(.+)-health\.lb-health\.company\.internal\.$"
            answer "{{ .Name }} 10 IN A {{ if service_healthy .Group 1 }}10.100.0.1{{ else }}10.100.0.2{{ end }}"
        }
    }
```

## Advanced Service Discovery Patterns

### Dynamic Service Registration

```yaml
# Service discovery webhook configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-webhook-config
  namespace: dns-system
data:
  webhook.conf: |
    webhook.company.internal:53 {
        errors
        log
        webhook {
            url http://service-registry.dns-system.svc.cluster.local:8080/dns
            timeout 5s
            fallthrough
        }
        cache 60
    }

---
# Service registry deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dns-service-registry
  namespace: dns-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: dns-service-registry
  template:
    metadata:
      labels:
        app: dns-service-registry
    spec:
      containers:
      - name: registry
        image: company/dns-service-registry:v1.2.0
        ports:
        - containerPort: 8080
        env:
        - name: KUBERNETES_NAMESPACE
          value: "default"
        - name: DNS_DOMAIN
          value: "company.internal"
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 256Mi

        # Health checks
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10

        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
```

### LoadBalancer Weight Distribution

```python
#!/usr/bin/env python3
"""
Dynamic LoadBalancer weight distribution for CoreDNS
"""

import json
import yaml
import requests
from kubernetes import client, config
from typing import Dict, List, Any
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class DNSLoadBalancerController:
    def __init__(self, namespace: str = "dns-system"):
        try:
            config.load_incluster_config()
        except:
            config.load_kube_config()

        self.v1 = client.CoreV1Api()
        self.namespace = namespace

    def update_loadbalancer_weights(self, service_name: str, weights: Dict[str, int]):
        """Update LoadBalancer weights based on service health"""

        # Get current CoreDNS configuration
        current_config = self._get_coredns_config()

        # Update weights in configuration
        updated_config = self._apply_weights(current_config, service_name, weights)

        # Apply updated configuration
        self._update_coredns_config(updated_config)

        logger.info(f"Updated LoadBalancer weights for {service_name}: {weights}")

    def _get_coredns_config(self) -> str:
        """Get current CoreDNS configuration"""
        try:
            cm = self.v1.read_namespaced_config_map(
                name="coredns-lb-config",
                namespace=self.namespace
            )
            return cm.data.get("Corefile", "")
        except Exception as e:
            logger.error(f"Failed to get CoreDNS config: {e}")
            return ""

    def _apply_weights(self, config: str, service_name: str, weights: Dict[str, int]) -> str:
        """Apply LoadBalancer weights to CoreDNS configuration"""
        lines = config.split('\n')
        updated_lines = []

        in_service_block = False

        for line in lines:
            if f"{service_name}.company.internal:53" in line:
                in_service_block = True
                updated_lines.append(line)
                continue

            if in_service_block and line.strip().startswith('}'):
                in_service_block = False

            if in_service_block and 'template IN A' in line:
                # Update template with weighted responses
                weighted_template = self._generate_weighted_template(service_name, weights)
                updated_lines.extend(weighted_template)
                continue

            updated_lines.append(line)

        return '\n'.join(updated_lines)

    def _generate_weighted_template(self, service_name: str, weights: Dict[str, int]) -> List[str]:
        """Generate weighted DNS template"""
        template_lines = [
            f'        template IN A {service_name}.company.internal {{',
            f'            match "^{service_name}\\.company\\.internal\\.$"'
        ]

        # Calculate total weight
        total_weight = sum(weights.values())

        # Generate weighted responses
        weight_ranges = []
        current_start = 0

        for endpoint, weight in weights.items():
            weight_percent = (weight / total_weight) * 100
            weight_end = current_start + weight_percent

            template_lines.append(
                f'            answer "{{ .Name }} 60 IN A {{ if and (ge (random 100) {current_start}) (lt (random 100) {weight_end}) }}{endpoint}{{ else }}{{ end }}"'
            )

            current_start = weight_end

        template_lines.extend([
            '            fallthrough',
            '        }'
        ])

        return template_lines

    def _update_coredns_config(self, config: str):
        """Update CoreDNS configuration"""
        try:
            # Update ConfigMap
            cm = self.v1.read_namespaced_config_map(
                name="coredns-lb-config",
                namespace=self.namespace
            )

            cm.data["Corefile"] = config

            self.v1.patch_namespaced_config_map(
                name="coredns-lb-config",
                namespace=self.namespace,
                body=cm
            )

            # Trigger CoreDNS reload
            self._reload_coredns()

        except Exception as e:
            logger.error(f"Failed to update CoreDNS config: {e}")

    def _reload_coredns(self):
        """Trigger CoreDNS configuration reload"""
        try:
            # Send SIGUSR1 to CoreDNS pods for graceful reload
            pods = self.v1.list_namespaced_pod(
                namespace=self.namespace,
                label_selector="app=coredns-lb"
            )

            for pod in pods.items:
                logger.info(f"Reloading CoreDNS configuration in pod {pod.metadata.name}")
                # Configuration reload happens automatically via the reload plugin

        except Exception as e:
            logger.error(f"Failed to reload CoreDNS: {e}")

    def monitor_service_health(self, services: List[str]):
        """Monitor service health and adjust weights"""
        while True:
            for service in services:
                try:
                    health_scores = self._get_service_health_scores(service)
                    weights = self._calculate_weights_from_health(health_scores)

                    self.update_loadbalancer_weights(service, weights)

                except Exception as e:
                    logger.error(f"Error monitoring service {service}: {e}")

            # Wait before next health check
            import time
            time.sleep(30)

    def _get_service_health_scores(self, service_name: str) -> Dict[str, float]:
        """Get health scores for service endpoints"""
        health_scores = {}

        try:
            # Get service endpoints
            endpoints = self.v1.read_namespaced_endpoints(
                name=service_name,
                namespace="default"
            )

            for subset in endpoints.subsets:
                for address in subset.addresses:
                    endpoint_ip = address.ip

                    # Perform health check
                    health_score = self._health_check_endpoint(endpoint_ip)
                    health_scores[endpoint_ip] = health_score

        except Exception as e:
            logger.error(f"Failed to get service health for {service_name}: {e}")

        return health_scores

    def _health_check_endpoint(self, endpoint_ip: str) -> float:
        """Perform health check on endpoint"""
        try:
            response = requests.get(
                f"http://{endpoint_ip}/health",
                timeout=5
            )

            if response.status_code == 200:
                # Parse response time as health indicator
                response_time = response.elapsed.total_seconds()

                # Convert response time to health score (lower is better)
                if response_time < 0.1:
                    return 1.0
                elif response_time < 0.5:
                    return 0.8
                elif response_time < 1.0:
                    return 0.6
                else:
                    return 0.4
            else:
                return 0.2  # Service responding but unhealthy

        except:
            return 0.0  # Service not responding

    def _calculate_weights_from_health(self, health_scores: Dict[str, float]) -> Dict[str, int]:
        """Calculate LoadBalancer weights based on health scores"""
        if not health_scores:
            return {}

        # Normalize health scores to weights (0-100)
        total_health = sum(health_scores.values())

        if total_health == 0:
            # All services unhealthy, distribute evenly
            num_services = len(health_scores)
            return {ip: 100 // num_services for ip in health_scores.keys()}

        weights = {}
        for ip, health in health_scores.items():
            weight = int((health / total_health) * 100)
            weights[ip] = max(weight, 5)  # Minimum weight of 5

        return weights

if __name__ == "__main__":
    controller = DNSLoadBalancerController()

    # Monitor specified services
    services_to_monitor = ["api", "web", "app"]

    controller.monitor_service_health(services_to_monitor)
```

## Enterprise Security and Access Control

### DNS Security Configuration

```yaml
# DNS security and access control
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: coredns-lb-network-policy
  namespace: dns-system
spec:
  podSelector:
    matchLabels:
      app: coredns-lb
  policyTypes:
  - Ingress
  - Egress

  ingress:
  # Allow DNS queries from all pods
  - from: []
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53

  # Allow metrics scraping from monitoring
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
    ports:
    - protocol: TCP
      port: 9153

  # Allow health checks
  - from: []
    ports:
    - protocol: TCP
      port: 8080
    - protocol: TCP
      port: 8181

  egress:
  # Allow DNS forwarding to upstream servers
  - to: []
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53

  # Allow API server communication
  - to: []
    ports:
    - protocol: TCP
      port: 6443

  # Allow communication with service registry
  - to:
    - podSelector:
        matchLabels:
          app: dns-service-registry
    ports:
    - protocol: TCP
      port: 8080

---
# RBAC configuration
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: coredns-lb-role
rules:
- apiGroups: [""]
  resources: ["endpoints", "services", "pods", "namespaces", "nodes"]
  verbs: ["list", "watch", "get"]
- apiGroups: ["discovery.k8s.io"]
  resources: ["endpointslices"]
  verbs: ["list", "watch", "get"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: coredns-lb-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: coredns-lb-role
subjects:
- kind: ServiceAccount
  name: coredns-lb
  namespace: dns-system

---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: coredns-lb
  namespace: dns-system
```

### DNS Query Logging and Auditing

```yaml
# DNS query logging configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-logging-config
  namespace: dns-system
data:
  logging.conf: |
    # Query logging for security auditing
    company.internal:53 {
        errors
        log {
            class all
            format "{type} {name} {rcode} {rtype} {>rflags} {>bufsize} {>do} {>id} {remote} {size} {duration}"
        }
        hosts /etc/coredns/hosts/NodeHosts {
            ttl 60
            reload 15s
            fallthrough
        }
        cache 300 {
            success 9984 30
            denial 9984 5
        }
    }

    # Security monitoring for suspicious queries
    .:53 {
        errors
        log {
            class denial error
        }
        # Rate limiting for abuse prevention
        ratelimit {
            per_second 100
            per_client 10
            whitelist 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
        }
        forward . /etc/resolv.conf
    }

---
# Fluent Bit configuration for DNS log forwarding
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-dns-config
  namespace: dns-system
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush         1
        Log_Level     info
        Daemon        off
        Parsers_File  parsers.conf

    [INPUT]
        Name              tail
        Path              /var/log/coredns/*.log
        Parser            coredns
        Tag               dns.queries
        Refresh_Interval  5
        Mem_Buf_Limit     50MB

    [FILTER]
        Name                geoip2
        Match               dns.queries
        Database            /etc/geoip/GeoLite2-City.mmdb
        Lookup_key          client_ip
        Record              city city.names.en
        Record              country country.iso_code

    [OUTPUT]
        Name  elasticsearch
        Match dns.queries
        Host  elasticsearch.logging.svc.cluster.local
        Port  9200
        Index dns-queries
        Type  _doc

  parsers.conf: |
    [PARSER]
        Name        coredns
        Format      regex
        Regex       ^(?<time>[^ ]*) \[(?<level>[^\]]*)\] (?<message>.*)$
        Time_Key    time
        Time_Format %Y-%m-%dT%H:%M:%S.%LZ
```

## Performance Optimization and Monitoring

### Advanced Caching Strategies

```yaml
# High-performance caching configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-cache-config
  namespace: dns-system
data:
  Corefile: |
    # Optimized caching for enterprise environments
    company.internal:53 {
        errors
        health {
            lameduck 5s
        }
        ready

        # Multi-tier caching strategy
        cache 3600 {
            # Success cache: 1 hour TTL, 10k entries, 30s prefetch
            success 10000 3600
            # Denial cache: 5 minute TTL, 1k entries
            denial 1000 300
            # Prefetch popular queries
            prefetch 50 300s 50%
            # Serve stale for 24 hours during upstream issues
            serve_stale 86400s
        }

        # Response size optimization
        bufsize 4096

        # Load balancing for cache efficiency
        loadbalance round_robin

        # Hosts file with optimized reload
        hosts /etc/coredns/hosts/NodeHosts {
            ttl 300
            reload 30s
            fallthrough
        }

        # Forward with connection pooling
        forward . /etc/resolv.conf {
            max_concurrent 2000
            policy sequential
            health_check 10s
            force_tcp
        }

        # Metrics for monitoring
        prometheus :9153

        # Query logging for cache optimization
        log {
            class response
        }
    }

    # High-frequency queries optimization
    api.company.internal:53 {
        errors
        # Aggressive caching for API endpoints
        cache 7200 {
            success 20000 7200
            denial 2000 600
            prefetch 100 600s 75%
            serve_stale 172800s
        }
        # Static mapping for performance
        template IN A api.company.internal {
            answer "api.company.internal 300 IN A 10.100.1.100"
        }
    }
```

### Performance Monitoring and Alerting

```yaml
# CoreDNS performance monitoring
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: coredns-lb-monitoring
  namespace: dns-system
spec:
  selector:
    matchLabels:
      app: coredns-lb
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
    honorLabels: true

---
# Performance alerting rules
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: coredns-lb-alerts
  namespace: dns-system
spec:
  groups:
  - name: coredns-loadbalancer
    rules:
    - alert: CoreDNSHighQueryLatency
      expr: histogram_quantile(0.99, sum(rate(coredns_dns_request_duration_seconds_bucket[5m])) by (le)) > 0.5
      for: 5m
      labels:
        severity: warning
        service: coredns-lb
      annotations:
        summary: "CoreDNS LoadBalancer high query latency"
        description: "99th percentile query latency is {{ $value }}s"

    - alert: CoreDNSHighErrorRate
      expr: sum(rate(coredns_dns_response_rcode_count_total{rcode!="NOERROR"}[5m])) / sum(rate(coredns_dns_response_rcode_count_total[5m])) > 0.05
      for: 2m
      labels:
        severity: critical
        service: coredns-lb
      annotations:
        summary: "CoreDNS LoadBalancer high error rate"
        description: "Error rate is {{ $value | humanizePercentage }}"

    - alert: CoreDNSCacheEfficiencyLow
      expr: (coredns_cache_hits_total / (coredns_cache_hits_total + coredns_cache_misses_total)) < 0.8
      for: 10m
      labels:
        severity: warning
        service: coredns-lb
      annotations:
        summary: "CoreDNS LoadBalancer low cache efficiency"
        description: "Cache hit rate is {{ $value | humanizePercentage }}"

    - alert: CoreDNSMemoryUsageHigh
      expr: process_resident_memory_bytes{job="coredns-lb"} / 1024 / 1024 > 512
      for: 15m
      labels:
        severity: warning
        service: coredns-lb
      annotations:
        summary: "CoreDNS LoadBalancer high memory usage"
        description: "Memory usage is {{ $value }}MB"
```

## Troubleshooting and Operational Excellence

### DNS Resolution Testing

```bash
#!/bin/bash
# Comprehensive DNS resolution testing script

set -euo pipefail

# Configuration
COREDNS_SERVICE="coredns-loadbalancer.dns-system.svc.cluster.local"
TEST_DOMAINS=(
    "api.company.internal"
    "web.company.internal"
    "app.company.internal"
    "health.company.internal"
    "api.us-east.company.com"
    "web.us-west.company.com"
)

# Test DNS resolution performance
test_dns_resolution() {
    local domain=$1
    local dns_server=${2:-$COREDNS_SERVICE}

    echo "Testing DNS resolution for $domain via $dns_server"

    # Test A record resolution
    local start_time=$(date +%s.%N)
    local result
    result=$(dig +short @$dns_server $domain A 2>/dev/null || echo "FAILED")
    local end_time=$(date +%s.%N)
    local duration=$(echo "$end_time - $start_time" | bc)

    if [[ "$result" == "FAILED" || -z "$result" ]]; then
        echo "❌ FAILED: $domain - No A record found"
        return 1
    else
        echo "✅ SUCCESS: $domain -> $result (${duration}s)"
        return 0
    fi
}

# Test LoadBalancer distribution
test_loadbalancer_distribution() {
    local domain=$1
    local iterations=${2:-10}

    echo "Testing LoadBalancer distribution for $domain ($iterations iterations)"

    declare -A ip_counts
    local total_requests=0

    for ((i=1; i<=iterations; i++)); do
        local result
        result=$(dig +short @$COREDNS_SERVICE $domain A 2>/dev/null | head -n1)

        if [[ -n "$result" ]]; then
            ((ip_counts[$result]++))
            ((total_requests++))
        fi
    done

    echo "LoadBalancer distribution results:"
    for ip in "${!ip_counts[@]}"; do
        local count=${ip_counts[$ip]}
        local percentage=$(echo "scale=2; $count * 100 / $total_requests" | bc)
        echo "  $ip: $count requests (${percentage}%)"
    done
}

# Test DNS cache performance
test_cache_performance() {
    local domain=$1
    local cache_test_iterations=5

    echo "Testing DNS cache performance for $domain"

    local uncached_times=()
    local cached_times=()

    # Clear DNS cache (if possible)
    kubectl exec -n dns-system deployment/coredns-loadbalancer -- \
        pkill -SIGUSR1 coredns 2>/dev/null || true
    sleep 2

    # Test uncached performance
    for ((i=1; i<=cache_test_iterations; i++)); do
        local start_time=$(date +%s.%N)
        dig +short @$COREDNS_SERVICE $domain A >/dev/null 2>&1
        local end_time=$(date +%s.%N)
        local duration=$(echo "$end_time - $start_time" | bc)
        uncached_times+=($duration)
    done

    # Test cached performance
    for ((i=1; i<=cache_test_iterations; i++)); do
        local start_time=$(date +%s.%N)
        dig +short @$COREDNS_SERVICE $domain A >/dev/null 2>&1
        local end_time=$(date +%s.%N)
        local duration=$(echo "$end_time - $start_time" | bc)
        cached_times+=($duration)
    done

    # Calculate averages
    local uncached_avg=$(printf '%s\n' "${uncached_times[@]}" | \
        awk '{sum+=$1} END {print sum/NR}')
    local cached_avg=$(printf '%s\n' "${cached_times[@]}" | \
        awk '{sum+=$1} END {print sum/NR}')

    echo "Cache performance results:"
    echo "  Uncached average: ${uncached_avg}s"
    echo "  Cached average: ${cached_avg}s"
    echo "  Performance improvement: $(echo "scale=2; $uncached_avg / $cached_avg" | bc)x"
}

# Test health endpoints
test_health_endpoints() {
    echo "Testing CoreDNS health endpoints"

    # Test health endpoint
    local health_response
    health_response=$(kubectl exec -n dns-system deployment/coredns-loadbalancer -- \
        curl -s http://localhost:8080/health)

    if [[ "$health_response" == "OK" ]]; then
        echo "✅ Health endpoint: OK"
    else
        echo "❌ Health endpoint: FAILED ($health_response)"
    fi

    # Test ready endpoint
    local ready_response
    ready_response=$(kubectl exec -n dns-system deployment/coredns-loadbalancer -- \
        curl -s http://localhost:8181/ready)

    if [[ "$ready_response" == "OK" ]]; then
        echo "✅ Ready endpoint: OK"
    else
        echo "❌ Ready endpoint: FAILED ($ready_response)"
    fi
}

# Main test execution
main() {
    echo "=== CoreDNS LoadBalancer DNS Testing ==="
    echo "Timestamp: $(date)"
    echo "DNS Server: $COREDNS_SERVICE"
    echo

    # Test basic DNS resolution
    echo "=== Basic DNS Resolution Tests ==="
    local failed_tests=0
    for domain in "${TEST_DOMAINS[@]}"; do
        test_dns_resolution "$domain" || ((failed_tests++))
    done
    echo

    # Test LoadBalancer distribution
    echo "=== LoadBalancer Distribution Tests ==="
    test_loadbalancer_distribution "api.company.internal" 20
    echo

    # Test cache performance
    echo "=== DNS Cache Performance Tests ==="
    test_cache_performance "web.company.internal"
    echo

    # Test health endpoints
    echo "=== Health Endpoint Tests ==="
    test_health_endpoints
    echo

    # Summary
    echo "=== Test Summary ==="
    echo "Total domains tested: ${#TEST_DOMAINS[@]}"
    echo "Failed tests: $failed_tests"

    if [[ $failed_tests -eq 0 ]]; then
        echo "✅ All tests passed!"
        exit 0
    else
        echo "❌ Some tests failed!"
        exit 1
    fi
}

# Execute main function
main "$@"
```

### Configuration Management and Automation

```bash
#!/bin/bash
# CoreDNS configuration management and deployment script

set -euo pipefail

NAMESPACE="dns-system"
CONFIG_DIR="/opt/coredns/config"
BACKUP_DIR="/opt/coredns/backups"

# Create backup of current configuration
backup_current_config() {
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$BACKUP_DIR/coredns-config-$timestamp.yaml"

    echo "Creating configuration backup: $backup_file"

    kubectl get configmap coredns-lb-config -n $NAMESPACE -o yaml > "$backup_file"
    kubectl get configmap coredns-lb-hosts -n $NAMESPACE -o yaml >> "$backup_file"

    echo "Backup created successfully"
}

# Validate CoreDNS configuration
validate_config() {
    local config_file=$1

    echo "Validating CoreDNS configuration: $config_file"

    # Create temporary pod for validation
    kubectl run coredns-validate \
        --image=coredns/coredns:1.10.1 \
        --rm -i --restart=Never \
        --namespace=$NAMESPACE \
        --command -- \
        /coredns -conf /dev/stdin -validate < "$config_file"

    echo "Configuration validation completed"
}

# Apply new configuration
apply_config() {
    local config_file=$1

    echo "Applying CoreDNS configuration: $config_file"

    # Update ConfigMap
    kubectl create configmap coredns-lb-config \
        --from-file=Corefile="$config_file" \
        --namespace=$NAMESPACE \
        --dry-run=client -o yaml | \
        kubectl apply -f -

    echo "Configuration applied successfully"
}

# Perform rolling update
rolling_update() {
    echo "Performing rolling update of CoreDNS LoadBalancer"

    # Trigger rolling update by updating deployment annotation
    kubectl patch deployment coredns-loadbalancer -n $NAMESPACE \
        -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"reloaded\":\"$(date +%s)\"}}}}}"

    # Wait for rollout to complete
    kubectl rollout status deployment/coredns-loadbalancer -n $NAMESPACE --timeout=300s

    echo "Rolling update completed successfully"
}

# Test configuration after deployment
test_deployment() {
    echo "Testing CoreDNS deployment"

    # Wait for pods to be ready
    kubectl wait --for=condition=ready pod \
        -l app=coredns-lb \
        -n $NAMESPACE \
        --timeout=120s

    # Test DNS resolution
    local test_domain="health.company.internal"
    local test_result

    test_result=$(kubectl exec -n $NAMESPACE deployment/coredns-loadbalancer -- \
        /coredns -dns.port=0 -conf /etc/coredns/Corefile -test=$test_domain)

    if [[ $? -eq 0 ]]; then
        echo "✅ Configuration test passed"
        return 0
    else
        echo "❌ Configuration test failed"
        return 1
    fi
}

# Rollback to previous configuration
rollback_config() {
    echo "Rolling back CoreDNS configuration"

    kubectl rollout undo deployment/coredns-loadbalancer -n $NAMESPACE

    kubectl rollout status deployment/coredns-loadbalancer -n $NAMESPACE --timeout=300s

    echo "Rollback completed"
}

# Main deployment function
deploy() {
    local config_file=${1:-"$CONFIG_DIR/Corefile"}

    if [[ ! -f "$config_file" ]]; then
        echo "Error: Configuration file not found: $config_file"
        exit 1
    fi

    echo "=== CoreDNS LoadBalancer Configuration Deployment ==="
    echo "Configuration file: $config_file"
    echo "Namespace: $NAMESPACE"
    echo "Timestamp: $(date)"
    echo

    # Create backup
    backup_current_config

    # Validate configuration
    if ! validate_config "$config_file"; then
        echo "Configuration validation failed. Aborting deployment."
        exit 1
    fi

    # Apply configuration
    apply_config "$config_file"

    # Perform rolling update
    rolling_update

    # Test deployment
    if ! test_deployment; then
        echo "Deployment test failed. Rolling back..."
        rollback_config
        exit 1
    fi

    echo "=== Deployment completed successfully ==="
}

# Command line handling
case "${1:-deploy}" in
    "deploy")
        deploy "${2:-}"
        ;;
    "backup")
        backup_current_config
        ;;
    "validate")
        validate_config "${2:-$CONFIG_DIR/Corefile}"
        ;;
    "rollback")
        rollback_config
        ;;
    "test")
        test_deployment
        ;;
    *)
        echo "Usage: $0 {deploy|backup|validate|rollback|test} [config_file]"
        exit 1
        ;;
esac
```

## Conclusion

CoreDNS provides enterprise-grade DNS resolution and LoadBalancer capabilities that enable sophisticated networking architectures in Kubernetes environments. The configurations and patterns presented in this guide demonstrate how organizations can implement scalable, highly available DNS infrastructure with advanced service discovery, geographic distribution, and comprehensive monitoring.

Key success factors include proper resource allocation, strategic caching configurations, comprehensive health monitoring, and robust operational procedures. Organizations implementing these patterns can expect significant improvements in DNS resolution performance, service discovery reliability, and overall network infrastructure resilience.

The combination of CoreDNS's plugin architecture, Kubernetes-native integration, and enterprise security controls provides a solid foundation for modern networking infrastructure capable of supporting complex application architectures and evolving business requirements.