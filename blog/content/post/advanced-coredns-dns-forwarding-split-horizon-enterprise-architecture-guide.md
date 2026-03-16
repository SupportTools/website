---
title: "Advanced CoreDNS Forwarding and Split-Horizon DNS: Enterprise Network Architecture for Complex Multi-Domain Environments"
date: 2026-03-25T00:00:00-05:00
draft: false
tags: ["CoreDNS", "DNS-Forwarding", "Split-Horizon", "Enterprise-Networking", "Kubernetes", "DNS-Architecture", "Network-Security"]
categories: ["Networking", "DNS", "Enterprise-Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing advanced DNS forwarding patterns with CoreDNS, featuring split-horizon DNS architectures, conditional forwarding strategies, and enterprise-grade network segmentation for complex organizational requirements."
more_link: "yes"
url: "/advanced-coredns-dns-forwarding-split-horizon-enterprise-architecture-guide/"
---

Advanced DNS forwarding architectures enable organizations to implement sophisticated network topologies with precise control over domain resolution across different network segments. CoreDNS provides the flexibility needed to build complex split-horizon DNS systems that support enterprise requirements for network segmentation, security isolation, and performance optimization.

<!--more-->

# Executive Summary

Enterprise networks require sophisticated DNS forwarding strategies that enable different network segments to resolve domains according to their specific access patterns and security requirements. CoreDNS's advanced forwarding capabilities support complex split-horizon DNS architectures, conditional forwarding based on client location, and intelligent routing strategies that optimize both security and performance. This guide presents production-ready configurations and architectural patterns for implementing enterprise-grade DNS forwarding systems.

## Advanced DNS Forwarding Architecture

### Split-Horizon DNS Foundation

Split-horizon DNS enables different DNS responses based on the source of the query, allowing organizations to present different views of their network infrastructure to internal and external users:

```yaml
# Advanced CoreDNS configuration for split-horizon DNS
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-split-horizon-config
  namespace: dns-system
  labels:
    app: coredns-enterprise
    component: split-horizon
data:
  Corefile: |
    # Internal corporate network view
    (internal-view) {
        # Corporate certificate validation
        tls /etc/ssl/certs/internal-ca.pem /etc/ssl/private/internal-key.pem {
            client_auth require_and_verify_client_cert /etc/ssl/certs/internal-ca.pem
        }

        # Comprehensive logging for audit compliance
        log {
            class all
            format "{type} {name} {rcode} {>rflags} {>bufsize} {>do} {>id} {remote} {size} {duration} {>opcode}"
        }

        # High-performance caching for internal queries
        cache 3600 {
            success 50000 3600
            denial 10000 300
            prefetch 100 900s 80%
            serve_stale 86400s
        }

        # Health monitoring
        health {
            lameduck 10s
        }

        # Metrics for internal monitoring
        prometheus :9153 {
            path /internal-metrics
        }
    }

    # External network view configuration
    (external-view) {
        # Rate limiting for external queries
        ratelimit {
            per_second 50
            per_client 5
            whitelist 203.0.113.0/24 198.51.100.0/24
            blacklist 192.0.2.0/24
        }

        # Basic logging for external queries
        log {
            class denial error
        }

        # Conservative caching for external queries
        cache 300 {
            success 10000 300
            denial 5000 60
        }

        # External health endpoint
        health {
            lameduck 5s
        }

        # Public metrics endpoint
        prometheus :9154 {
            path /external-metrics
        }
    }

    # Internal corporate domains - comprehensive resolution
    company.internal:53 {
        import internal-view

        # Multi-source resolution strategy
        hosts /etc/coredns/internal-hosts {
            ttl 300
            reload 30s
            fallthrough
        }

        # Database-backed dynamic records
        mysql {
            dsn "dns_user:dns_pass@tcp(mysql.dns-system:3306)/dns_db"
            query "SELECT ip FROM dns_records WHERE domain = ? AND type = 'A' AND zone = 'internal'"
            ttl 300
        }

        # Template-based service discovery
        template IN A {
            match "^(.+)-([0-9]+)\.company\.internal\.$"
            answer "{{ .Name }} 300 IN A {{ index (service (printf \"%s.%s\" (.Group 1) (.Group 2))) \"clusterIP\" }}"
            fallthrough
        }

        # Kubernetes service integration
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
            endpoint_pod_names
            upstream /etc/resolv.conf
        }

        # Conditional forwarding to regional DNS
        forward . dns-internal.company.com:53 {
            max_concurrent 1000
            policy sequential
            health_check 15s
            tls_servername dns-internal.company.com
        }
    }

    # Development environment domains
    dev.company.internal:53 {
        import internal-view

        # Development-specific host mappings
        hosts /etc/coredns/dev-hosts {
            ttl 60
            reload 15s
            fallthrough
        }

        # Forward to development DNS servers
        forward . 192.168.100.10 192.168.100.11 {
            max_concurrent 500
            policy round_robin
            health_check 10s
        }
    }

    # Staging environment with restricted access
    staging.company.internal:53 {
        # Access control based on client IP
        acl {
            allow 192.168.200.0/24
            allow 10.100.0.0/16
            deny all
        }

        import internal-view

        # Staging host mappings
        hosts /etc/coredns/staging-hosts {
            ttl 120
            reload 20s
            fallthrough
        }

        # Forward to staging infrastructure
        forward . staging-dns.company.internal:53 {
            max_concurrent 200
            policy sequential
            health_check 20s
        }
    }

    # External public domains
    company.com:53 {
        import external-view

        # Public records from authoritative sources
        hosts /etc/coredns/public-hosts {
            ttl 300
            reload 60s
            fallthrough
        }

        # GeoDNS for global load balancing
        geodns {
            config /etc/coredns/geodns.conf
            fallthrough
        }

        # Forward to public authoritative servers
        forward . ns1.company.com:53 ns2.company.com:53 {
            max_concurrent 2000
            policy random
            health_check 30s
        }
    }

    # Partner network domains
    partner.company.com:53 {
        # Partner-specific access control
        acl {
            allow 203.0.113.0/24    # Partner Network A
            allow 198.51.100.0/24   # Partner Network B
            deny all
        }

        import external-view

        # Partner host mappings
        hosts /etc/coredns/partner-hosts {
            ttl 600
            reload 45s
            fallthrough
        }

        # Multi-region partner DNS forwarding
        forward . partner-dns-east.company.com:53 partner-dns-west.company.com:53 {
            max_concurrent 500
            policy sequential
            health_check 25s
        }
    }

    # Cloud provider domains
    aws.company.internal:53 {
        import internal-view

        # AWS Route53 integration
        route53 {
            region us-east-1
            hosted_zone_id ZXXXXXXXXXXXXX
            fallthrough
        }

        # Forward to AWS internal resolvers
        forward . 169.254.169.253:53 {
            max_concurrent 1000
            policy sequential
        }
    }

    azure.company.internal:53 {
        import internal-view

        # Azure DNS integration
        azuredns {
            subscription_id "xxxx-xxxx-xxxx-xxxx"
            resource_group "dns-resources"
            fallthrough
        }

        # Forward to Azure internal resolvers
        forward . 168.63.129.16:53 {
            max_concurrent 1000
            policy sequential
        }
    }

    # Default forwarding for unknown domains
    .:53 {
        import external-view

        # DNS over HTTPS for enhanced security
        forward . tls://1.1.1.1:853 tls://8.8.8.8:853 {
            tls_servername cloudflare-dns.com
            max_concurrent 2000
            policy random
            health_check 60s
        }

        # Fallback to traditional DNS
        forward . 8.8.8.8:53 1.1.1.1:53 {
            max_concurrent 1000
            policy random
            health_check 30s
        }
    }
```

### Advanced Host Mapping Configuration

```yaml
# Internal network host mappings
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-internal-hosts
  namespace: dns-system
data:
  internal-hosts: |
    # Executive infrastructure
    10.0.1.10    ceo-desktop.company.internal
    10.0.1.11    cfo-laptop.company.internal
    10.0.1.12    boardroom-system.company.internal

    # IT Infrastructure
    10.0.10.10   ad-controller-1.company.internal dc1.company.internal
    10.0.10.11   ad-controller-2.company.internal dc2.company.internal
    10.0.10.20   exchange-server.company.internal mail.company.internal
    10.0.10.30   sharepoint.company.internal portal.company.internal

    # Database infrastructure
    10.0.20.10   db-primary.company.internal database.company.internal
    10.0.20.11   db-secondary.company.internal db-backup.company.internal
    10.0.20.20   redis-cluster.company.internal cache.company.internal

    # Application servers
    10.0.30.10   app-server-1.company.internal
    10.0.30.11   app-server-2.company.internal
    10.0.30.12   app-server-3.company.internal

    # Load balancers
    10.0.40.10   lb-internal.company.internal
    10.0.40.11   lb-external.company.internal
    10.0.40.20   api-gateway.company.internal api.company.internal

    # Monitoring infrastructure
    10.0.50.10   prometheus.company.internal monitoring.company.internal
    10.0.50.11   grafana.company.internal dashboards.company.internal
    10.0.50.12   alertmanager.company.internal alerts.company.internal

    # Security infrastructure
    10.0.60.10   security-scanner.company.internal
    10.0.60.11   vulnerability-db.company.internal
    10.0.60.12   siem-system.company.internal

---
# Development environment hosts
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-dev-hosts
  namespace: dns-system
data:
  dev-hosts: |
    # Development API endpoints
    192.168.100.10   api-dev.dev.company.internal
    192.168.100.11   web-dev.dev.company.internal
    192.168.100.12   db-dev.dev.company.internal

    # Developer workstations
    192.168.100.50   dev-workstation-1.dev.company.internal
    192.168.100.51   dev-workstation-2.dev.company.internal
    192.168.100.52   dev-workstation-3.dev.company.internal

    # CI/CD infrastructure
    192.168.100.100  jenkins-dev.dev.company.internal
    192.168.100.101  gitlab-dev.dev.company.internal
    192.168.100.102  docker-registry-dev.dev.company.internal

---
# Staging environment hosts
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-staging-hosts
  namespace: dns-system
data:
  staging-hosts: |
    # Staging application stack
    192.168.200.10   api-staging.staging.company.internal
    192.168.200.11   web-staging.staging.company.internal
    192.168.200.12   db-staging.staging.company.internal

    # Staging load balancers
    192.168.200.20   lb-staging.staging.company.internal

    # Testing infrastructure
    192.168.200.30   test-runner.staging.company.internal
    192.168.200.31   performance-tester.staging.company.internal

---
# Public-facing hosts
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-public-hosts
  namespace: dns-system
data:
  public-hosts: |
    # Public web properties
    203.0.113.10     www.company.com
    203.0.113.11     api.company.com
    203.0.113.12     cdn.company.com

    # Email infrastructure
    203.0.113.20     mail.company.com mx1.company.com
    203.0.113.21     mail2.company.com mx2.company.com

    # Support infrastructure
    203.0.113.30     support.company.com help.company.com
    203.0.113.31     docs.company.com documentation.company.com

---
# Partner network hosts
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-partner-hosts
  namespace: dns-system
data:
  partner-hosts: |
    # Partner A infrastructure
    198.51.100.10    partner-a-api.partner.company.com
    198.51.100.11    partner-a-web.partner.company.com

    # Partner B infrastructure
    198.51.100.20    partner-b-api.partner.company.com
    198.51.100.21    partner-b-web.partner.company.com

    # Shared partner services
    198.51.100.100   shared-auth.partner.company.com
    198.51.100.101   shared-data.partner.company.com
```

## Geographic DNS and Multi-Region Forwarding

### Geographic DNS Configuration

```yaml
# GeoDNS configuration for global load balancing
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-geodns-config
  namespace: dns-system
data:
  geodns.conf: |
    # Global configuration
    [global]
    geoip_database = "/etc/geoip/GeoLite2-City.mmdb"
    default_region = "us-east"

    # Regional endpoint mappings
    [regions]
    us-east = ["us", "ca", "mx"]
    us-west = ["us-west"]
    eu-west = ["gb", "ie", "fr", "de", "es", "it", "nl", "be"]
    eu-central = ["pl", "cz", "at", "ch", "hu"]
    asia-pacific = ["jp", "kr", "au", "nz", "sg", "hk"]

    # Service endpoint definitions
    [services]
    api.company.com = {
        us-east = "api-use1.company.com",
        us-west = "api-usw1.company.com",
        eu-west = "api-euw1.company.com",
        eu-central = "api-euc1.company.com",
        asia-pacific = "api-ap1.company.com"
    }

    web.company.com = {
        us-east = "web-use1.company.com",
        us-west = "web-usw1.company.com",
        eu-west = "web-euw1.company.com",
        eu-central = "web-euc1.company.com",
        asia-pacific = "web-ap1.company.com"
    }

    # Health check configuration
    [healthchecks]
    api-use1.company.com = "https://api-use1.company.com/health"
    api-usw1.company.com = "https://api-usw1.company.com/health"
    api-euw1.company.com = "https://api-euw1.company.com/health"
    api-euc1.company.com = "https://api-euc1.company.com/health"
    api-ap1.company.com = "https://api-ap1.company.com/health"

    # Failover configuration
    [failover]
    api.company.com = ["api-use1.company.com", "api-usw1.company.com", "api-euw1.company.com"]
    web.company.com = ["web-use1.company.com", "web-usw1.company.com", "web-euw1.company.com"]

---
# Geographic deployment for multi-region CoreDNS
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coredns-geo-us-east
  namespace: dns-system
  labels:
    app: coredns-geo
    region: us-east
spec:
  replicas: 3
  selector:
    matchLabels:
      app: coredns-geo
      region: us-east
  template:
    metadata:
      labels:
        app: coredns-geo
        region: us-east
    spec:
      serviceAccountName: coredns-geo

      # Regional node placement
      nodeSelector:
        topology.kubernetes.io/region: us-east-1

      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: coredns-geo
                region: us-east
            topologyKey: kubernetes.io/hostname

      containers:
      - name: coredns
        image: coredns/coredns:1.10.1

        # Enhanced resource allocation for geo-distributed workloads
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi

        env:
        - name: REGION
          value: "us-east"
        - name: DATACENTER
          value: "us-east-1"

        ports:
        - containerPort: 53
          name: dns-udp
          protocol: UDP
        - containerPort: 53
          name: dns-tcp
          protocol: TCP
        - containerPort: 9153
          name: metrics
          protocol: TCP

        volumeMounts:
        - name: config
          mountPath: /etc/coredns
          readOnly: true
        - name: geodns-config
          mountPath: /etc/coredns/geodns.conf
          subPath: geodns.conf
          readOnly: true
        - name: geoip-data
          mountPath: /etc/geoip
          readOnly: true

        # Regional health checks
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10

        readinessProbe:
          httpGet:
            path: /ready
            port: 8181
          initialDelaySeconds: 5
          periodSeconds: 5

      volumes:
      - name: config
        configMap:
          name: coredns-split-horizon-config
      - name: geodns-config
        configMap:
          name: coredns-geodns-config
      - name: geoip-data
        configMap:
          name: geoip-database
```

### Conditional Forwarding Based on Client Location

```python
#!/usr/bin/env python3
"""
Dynamic DNS forwarding controller for geographic and network-based routing
"""

import ipaddress
import json
import yaml
from kubernetes import client, config
from typing import Dict, List, Set, Tuple
import geoip2.database
import geoip2.errors
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ConditionalForwardingController:
    def __init__(self, namespace: str = "dns-system"):
        try:
            config.load_incluster_config()
        except:
            config.load_kube_config()

        self.v1 = client.CoreV1Api()
        self.namespace = namespace

        # Load GeoIP database
        self.geoip_reader = geoip2.database.Reader('/etc/geoip/GeoLite2-City.mmdb')

        # Network segment definitions
        self.network_segments = {
            'internal': [
                ipaddress.IPv4Network('10.0.0.0/8'),
                ipaddress.IPv4Network('172.16.0.0/12'),
                ipaddress.IPv4Network('192.168.0.0/16')
            ],
            'dmz': [
                ipaddress.IPv4Network('203.0.113.0/24'),
                ipaddress.IPv4Network('198.51.100.0/24')
            ],
            'partners': [
                ipaddress.IPv4Network('203.0.113.128/25'),
                ipaddress.IPv4Network('198.51.100.128/25')
            ],
            'external': [
                ipaddress.IPv4Network('0.0.0.0/0')  # Catch-all for external traffic
            ]
        }

        # Forwarding rules
        self.forwarding_rules = self._load_forwarding_rules()

    def _load_forwarding_rules(self) -> Dict:
        """Load DNS forwarding rules from configuration"""
        return {
            'internal': {
                'company.internal': ['dns-internal-1.company.com:53', 'dns-internal-2.company.com:53'],
                'dev.company.internal': ['dns-dev.company.com:53'],
                'staging.company.internal': ['dns-staging.company.com:53']
            },
            'dmz': {
                'company.com': ['ns1.company.com:53', 'ns2.company.com:53'],
                'partner.company.com': ['partner-dns.company.com:53']
            },
            'partners': {
                'partner.company.com': ['partner-dns-1.company.com:53', 'partner-dns-2.company.com:53'],
                'shared.company.com': ['shared-dns.company.com:53']
            },
            'external': {
                '.': ['8.8.8.8:53', '1.1.1.1:53']
            }
        }

    def determine_client_segment(self, client_ip: str) -> str:
        """Determine network segment based on client IP"""
        try:
            client_addr = ipaddress.IPv4Address(client_ip)

            for segment_name, networks in self.network_segments.items():
                for network in networks:
                    if client_addr in network:
                        if segment_name == 'external':
                            # Further classify external clients by geography
                            try:
                                response = self.geoip_reader.city(client_ip)
                                country_code = response.country.iso_code

                                if country_code in ['US', 'CA', 'MX']:
                                    return 'external-na'
                                elif country_code in ['GB', 'IE', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE']:
                                    return 'external-eu'
                                elif country_code in ['JP', 'KR', 'AU', 'NZ', 'SG', 'HK']:
                                    return 'external-apac'
                                else:
                                    return 'external'
                            except geoip2.errors.AddressNotFoundError:
                                return 'external'

                        return segment_name

            return 'external'

        except ipaddress.AddressValueError:
            logger.warning(f"Invalid IP address: {client_ip}")
            return 'external'

    def generate_conditional_config(self) -> str:
        """Generate CoreDNS configuration with conditional forwarding"""

        config_template = """
# Conditional forwarding configuration based on client location
(conditional-forwarding) {{
    errors
    log {{
        class all
        format "{{{{.Type}}}} {{{{.Name}}}} {{{{.Rcode}}}} {{{{.Remote}}}} {{{{.Duration}}}}"
    }}
    health {{
        lameduck 10s
    }}
    ready
    cache 300 {{
        success 10000 300
        denial 5000 60
        prefetch 50 60s 30%
    }}
    prometheus :9153
}}

# Client-based forwarding rules
{forwarding_blocks}

# Default forwarding
.:53 {{
    import conditional-forwarding
    forward . 8.8.8.8:53 1.1.1.1:53 {{
        max_concurrent 1000
        policy random
        health_check 30s
    }}
}}
"""

        forwarding_blocks = []

        # Generate forwarding blocks for each network segment
        for segment, rules in self.forwarding_rules.items():
            segment_block = self._generate_segment_block(segment, rules)
            forwarding_blocks.append(segment_block)

        return config_template.format(
            forwarding_blocks='\n\n'.join(forwarding_blocks)
        )

    def _generate_segment_block(self, segment: str, rules: Dict[str, List[str]]) -> str:
        """Generate CoreDNS configuration block for a network segment"""

        # ACL rules based on segment
        acl_rules = self._generate_acl_rules(segment)

        segment_blocks = []

        for domain, forwarders in rules.items():
            forwarder_list = ' '.join(forwarders)

            domain_block = f"""
# {segment.upper()} segment - {domain}
{domain}:53 {{
{acl_rules}
    import conditional-forwarding

    forward . {forwarder_list} {{
        max_concurrent 1000
        policy sequential
        health_check 15s
    }}
}}"""
            segment_blocks.append(domain_block)

        return '\n'.join(segment_blocks)

    def _generate_acl_rules(self, segment: str) -> str:
        """Generate ACL rules for network segment"""
        if segment == 'internal':
            return """    acl {
        allow 10.0.0.0/8
        allow 172.16.0.0/12
        allow 192.168.0.0/16
        deny all
    }"""
        elif segment == 'dmz':
            return """    acl {
        allow 203.0.113.0/24
        allow 198.51.100.0/24
        allow 10.0.0.0/8
        allow 172.16.0.0/12
        allow 192.168.0.0/16
        deny all
    }"""
        elif segment == 'partners':
            return """    acl {
        allow 203.0.113.128/25
        allow 198.51.100.128/25
        deny all
    }"""
        else:
            return """    # External access - no restrictions"""

    def update_coredns_configuration(self):
        """Update CoreDNS configuration with conditional forwarding rules"""
        try:
            # Generate new configuration
            new_config = self.generate_conditional_config()

            # Update ConfigMap
            cm = self.v1.read_namespaced_config_map(
                name="coredns-split-horizon-config",
                namespace=self.namespace
            )

            cm.data["Corefile"] = new_config

            self.v1.patch_namespaced_config_map(
                name="coredns-split-horizon-config",
                namespace=self.namespace,
                body=cm
            )

            logger.info("CoreDNS configuration updated with conditional forwarding rules")

            # Trigger configuration reload
            self._reload_coredns_pods()

        except Exception as e:
            logger.error(f"Failed to update CoreDNS configuration: {e}")

    def _reload_coredns_pods(self):
        """Trigger graceful reload of CoreDNS pods"""
        try:
            pods = self.v1.list_namespaced_pod(
                namespace=self.namespace,
                label_selector="app=coredns-enterprise"
            )

            for pod in pods.items:
                logger.info(f"Triggering configuration reload for pod {pod.metadata.name}")

                # Configuration reload happens automatically via the reload plugin
                # No explicit action needed

        except Exception as e:
            logger.error(f"Failed to reload CoreDNS pods: {e}")

    def monitor_network_changes(self):
        """Monitor network topology changes and update forwarding rules"""
        import time

        while True:
            try:
                # Check for network topology changes
                self._detect_network_changes()

                # Update configuration if changes detected
                self.update_coredns_configuration()

                # Wait for next check interval
                time.sleep(300)  # 5 minutes

            except Exception as e:
                logger.error(f"Error during network monitoring: {e}")
                time.sleep(60)  # Shorter retry interval on error

    def _detect_network_changes(self):
        """Detect changes in network topology that require configuration updates"""
        # Implementation would monitor:
        # - Changes in service endpoints
        # - New network segments
        # - DNS server health status
        # - Geographic routing changes
        pass

if __name__ == "__main__":
    controller = ConditionalForwardingController()

    # Start monitoring network changes
    controller.monitor_network_changes()
```

## Database-Backed Dynamic DNS

### MySQL Integration for Dynamic Records

```yaml
# MySQL database configuration for dynamic DNS records
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dns-mysql
  namespace: dns-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: dns-mysql
  template:
    metadata:
      labels:
        app: dns-mysql
    spec:
      containers:
      - name: mysql
        image: mysql:8.0
        env:
        - name: MYSQL_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: dns-mysql-secret
              key: root-password
        - name: MYSQL_DATABASE
          value: "dns_db"
        - name: MYSQL_USER
          value: "dns_user"
        - name: MYSQL_PASSWORD
          valueFrom:
            secretKeyRef:
              name: dns-mysql-secret
              key: user-password

        ports:
        - containerPort: 3306

        volumeMounts:
        - name: mysql-data
          mountPath: /var/lib/mysql
        - name: mysql-config
          mountPath: /etc/mysql/conf.d
          readOnly: true

        # Resource allocation
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 1000m
            memory: 2Gi

        # Health checks
        livenessProbe:
          exec:
            command:
            - mysqladmin
            - ping
            - -h
            - localhost
          initialDelaySeconds: 30
          periodSeconds: 10

        readinessProbe:
          exec:
            command:
            - mysqladmin
            - ping
            - -h
            - localhost
          initialDelaySeconds: 5
          periodSeconds: 5

      volumes:
      - name: mysql-data
        persistentVolumeClaim:
          claimName: dns-mysql-pvc
      - name: mysql-config
        configMap:
          name: dns-mysql-config

---
# MySQL service
apiVersion: v1
kind: Service
metadata:
  name: dns-mysql
  namespace: dns-system
spec:
  selector:
    app: dns-mysql
  ports:
  - port: 3306
    targetPort: 3306
  type: ClusterIP

---
# Database schema initialization
apiVersion: v1
kind: ConfigMap
metadata:
  name: dns-mysql-init
  namespace: dns-system
data:
  init.sql: |
    CREATE DATABASE IF NOT EXISTS dns_db;
    USE dns_db;

    -- DNS records table
    CREATE TABLE IF NOT EXISTS dns_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        type ENUM('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR') NOT NULL,
        value VARCHAR(255) NOT NULL,
        ttl INT DEFAULT 300,
        zone VARCHAR(255) NOT NULL,
        priority INT DEFAULT 0,
        weight INT DEFAULT 0,
        port INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_domain_type (domain, type),
        INDEX idx_zone (zone)
    );

    -- DNS zones table
    CREATE TABLE IF NOT EXISTS dns_zones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        zone_name VARCHAR(255) NOT NULL UNIQUE,
        zone_type ENUM('internal', 'external', 'partner') NOT NULL,
        authoritative BOOLEAN DEFAULT FALSE,
        serial_number INT DEFAULT 1,
        refresh_interval INT DEFAULT 3600,
        retry_interval INT DEFAULT 1800,
        expire_interval INT DEFAULT 604800,
        minimum_ttl INT DEFAULT 300,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );

    -- Load balancer health status table
    CREATE TABLE IF NOT EXISTS lb_health_status (
        id INT AUTO_INCREMENT PRIMARY KEY,
        endpoint VARCHAR(255) NOT NULL,
        status ENUM('healthy', 'unhealthy', 'unknown') NOT NULL,
        response_time_ms INT DEFAULT 0,
        last_check TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        consecutive_failures INT DEFAULT 0,
        UNIQUE KEY unique_endpoint (endpoint)
    );

    -- Insert sample data
    INSERT INTO dns_zones (zone_name, zone_type, authoritative) VALUES
    ('company.internal', 'internal', TRUE),
    ('dev.company.internal', 'internal', TRUE),
    ('partner.company.com', 'partner', TRUE),
    ('company.com', 'external', FALSE);

    INSERT INTO dns_records (domain, type, value, ttl, zone) VALUES
    ('api.company.internal', 'A', '10.0.30.10', 300, 'internal'),
    ('api.company.internal', 'A', '10.0.30.11', 300, 'internal'),
    ('api.company.internal', 'A', '10.0.30.12', 300, 'internal'),
    ('web.company.internal', 'A', '10.0.40.10', 300, 'internal'),
    ('web.company.internal', 'A', '10.0.40.11', 300, 'internal'),
    ('database.company.internal', 'A', '10.0.20.10', 300, 'internal'),
    ('mail.company.com', 'A', '203.0.113.20', 300, 'external'),
    ('www.company.com', 'A', '203.0.113.10', 300, 'external');

    -- Create user and grant permissions
    CREATE USER IF NOT EXISTS 'dns_user'@'%' IDENTIFIED BY 'secure_dns_password';
    GRANT SELECT, INSERT, UPDATE, DELETE ON dns_db.* TO 'dns_user'@'%';
    FLUSH PRIVILEGES;
```

### Dynamic DNS Record Management

```python
#!/usr/bin/env python3
"""
Dynamic DNS record management system for CoreDNS
"""

import mysql.connector
from kubernetes import client, config
import json
import time
import logging
from typing import List, Dict, Any, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class DNSRecordManager:
    def __init__(self, db_config: Dict[str, str]):
        self.db_config = db_config
        self.connection = None

        # Initialize Kubernetes client
        try:
            config.load_incluster_config()
        except:
            config.load_kube_config()

        self.v1 = client.CoreV1Api()
        self.apps_v1 = client.AppsV1Api()

    def connect_database(self):
        """Connect to MySQL database"""
        try:
            self.connection = mysql.connector.connect(
                host=self.db_config['host'],
                port=self.db_config['port'],
                user=self.db_config['user'],
                password=self.db_config['password'],
                database=self.db_config['database']
            )
            logger.info("Connected to DNS database")
        except mysql.connector.Error as e:
            logger.error(f"Failed to connect to database: {e}")
            raise

    def get_dns_records(self, zone: str = None) -> List[Dict[str, Any]]:
        """Retrieve DNS records from database"""
        if not self.connection or not self.connection.is_connected():
            self.connect_database()

        cursor = self.connection.cursor(dictionary=True)

        if zone:
            query = """
                SELECT domain, type, value, ttl, priority, weight, port
                FROM dns_records
                WHERE zone = %s AND ttl > 0
                ORDER BY domain, type
            """
            cursor.execute(query, (zone,))
        else:
            query = """
                SELECT domain, type, value, ttl, priority, weight, port, zone
                FROM dns_records
                WHERE ttl > 0
                ORDER BY zone, domain, type
            """
            cursor.execute(query)

        records = cursor.fetchall()
        cursor.close()
        return records

    def add_dns_record(self, domain: str, record_type: str, value: str,
                      ttl: int = 300, zone: str = 'internal',
                      priority: int = 0, weight: int = 0, port: int = 0):
        """Add a new DNS record"""
        if not self.connection or not self.connection.is_connected():
            self.connect_database()

        cursor = self.connection.cursor()

        query = """
            INSERT INTO dns_records (domain, type, value, ttl, zone, priority, weight, port)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """

        cursor.execute(query, (domain, record_type.upper(), value, ttl, zone, priority, weight, port))
        self.connection.commit()
        cursor.close()

        logger.info(f"Added DNS record: {domain} {record_type} {value}")

    def update_dns_record(self, domain: str, record_type: str, old_value: str,
                         new_value: str, zone: str = 'internal'):
        """Update existing DNS record"""
        if not self.connection or not self.connection.is_connected():
            self.connect_database()

        cursor = self.connection.cursor()

        query = """
            UPDATE dns_records
            SET value = %s, updated_at = CURRENT_TIMESTAMP
            WHERE domain = %s AND type = %s AND value = %s AND zone = %s
        """

        cursor.execute(query, (new_value, domain, record_type.upper(), old_value, zone))
        self.connection.commit()
        cursor.close()

        logger.info(f"Updated DNS record: {domain} {record_type} {old_value} -> {new_value}")

    def delete_dns_record(self, domain: str, record_type: str, value: str, zone: str = 'internal'):
        """Delete DNS record"""
        if not self.connection or not self.connection.is_connected():
            self.connect_database()

        cursor = self.connection.cursor()

        query = """
            DELETE FROM dns_records
            WHERE domain = %s AND type = %s AND value = %s AND zone = %s
        """

        cursor.execute(query, (domain, record_type.upper(), value, zone))
        self.connection.commit()
        cursor.close()

        logger.info(f"Deleted DNS record: {domain} {record_type} {value}")

    def sync_kubernetes_services(self):
        """Synchronize Kubernetes services to DNS records"""
        try:
            # Get all services across all namespaces
            services = self.v1.list_service_for_all_namespaces()

            for service in services.items:
                namespace = service.metadata.namespace
                service_name = service.metadata.name

                # Skip system services
                if namespace in ['kube-system', 'kube-public', 'kube-node-lease']:
                    continue

                # Generate DNS name
                dns_name = f"{service_name}.{namespace}.company.internal"

                # Get service endpoints
                try:
                    endpoints = self.v1.read_namespaced_endpoints(
                        name=service_name,
                        namespace=namespace
                    )

                    # Extract endpoint IPs
                    endpoint_ips = []
                    if endpoints.subsets:
                        for subset in endpoints.subsets:
                            if subset.addresses:
                                for address in subset.addresses:
                                    endpoint_ips.append(address.ip)

                    # Update DNS records
                    if endpoint_ips:
                        self._update_service_dns_records(dns_name, endpoint_ips, 'internal')

                except client.exceptions.ApiException as e:
                    if e.status != 404:  # Ignore not found errors
                        logger.warning(f"Failed to get endpoints for {service_name}: {e}")

        except Exception as e:
            logger.error(f"Failed to sync Kubernetes services: {e}")

    def _update_service_dns_records(self, domain: str, ips: List[str], zone: str):
        """Update DNS records for a service"""
        # Get existing records
        existing_records = self.get_dns_records_for_domain(domain, zone)
        existing_ips = {record['value'] for record in existing_records}

        new_ips = set(ips)

        # Add new IPs
        for ip in new_ips - existing_ips:
            self.add_dns_record(domain, 'A', ip, 300, zone)

        # Remove old IPs
        for ip in existing_ips - new_ips:
            self.delete_dns_record(domain, 'A', ip, zone)

    def get_dns_records_for_domain(self, domain: str, zone: str) -> List[Dict[str, Any]]:
        """Get all DNS records for a specific domain"""
        if not self.connection or not self.connection.is_connected():
            self.connect_database()

        cursor = self.connection.cursor(dictionary=True)

        query = """
            SELECT domain, type, value, ttl, priority, weight, port
            FROM dns_records
            WHERE domain = %s AND zone = %s
            ORDER BY type, value
        """

        cursor.execute(query, (domain, zone))
        records = cursor.fetchall()
        cursor.close()
        return records

    def monitor_service_health(self):
        """Monitor service health and update DNS records accordingly"""
        while True:
            try:
                # Get all registered endpoints
                cursor = self.connection.cursor(dictionary=True)
                cursor.execute("""
                    SELECT DISTINCT value as ip, domain, zone
                    FROM dns_records
                    WHERE type = 'A' AND zone IN ('internal', 'external')
                """)

                endpoints = cursor.fetchall()
                cursor.close()

                # Check health of each endpoint
                for endpoint in endpoints:
                    health_status = self._check_endpoint_health(
                        endpoint['ip'],
                        endpoint['domain']
                    )

                    self._update_health_status(
                        endpoint['ip'],
                        health_status
                    )

                # Wait for next health check cycle
                time.sleep(30)

            except Exception as e:
                logger.error(f"Error during health monitoring: {e}")
                time.sleep(60)  # Retry after error

    def _check_endpoint_health(self, ip: str, domain: str) -> Dict[str, Any]:
        """Check health of a specific endpoint"""
        import requests

        try:
            # Try health check endpoint
            health_url = f"http://{ip}/health"
            start_time = time.time()

            response = requests.get(health_url, timeout=5)
            response_time = (time.time() - start_time) * 1000  # Convert to ms

            if response.status_code == 200:
                return {
                    'status': 'healthy',
                    'response_time_ms': int(response_time)
                }
            else:
                return {
                    'status': 'unhealthy',
                    'response_time_ms': int(response_time)
                }

        except requests.exceptions.RequestException:
            return {
                'status': 'unhealthy',
                'response_time_ms': 0
            }

    def _update_health_status(self, endpoint: str, health_status: Dict[str, Any]):
        """Update health status in database"""
        if not self.connection or not self.connection.is_connected():
            self.connect_database()

        cursor = self.connection.cursor()

        # Update or insert health status
        query = """
            INSERT INTO lb_health_status (endpoint, status, response_time_ms, last_check, consecutive_failures)
            VALUES (%s, %s, %s, CURRENT_TIMESTAMP, %s)
            ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            response_time_ms = VALUES(response_time_ms),
            last_check = VALUES(last_check),
            consecutive_failures = CASE
                WHEN VALUES(status) = 'healthy' THEN 0
                ELSE consecutive_failures + 1
            END
        """

        consecutive_failures = 0 if health_status['status'] == 'healthy' else 1

        cursor.execute(query, (
            endpoint,
            health_status['status'],
            health_status['response_time_ms'],
            consecutive_failures
        ))

        self.connection.commit()
        cursor.close()

if __name__ == "__main__":
    db_config = {
        'host': 'dns-mysql.dns-system.svc.cluster.local',
        'port': 3306,
        'user': 'dns_user',
        'password': 'secure_dns_password',
        'database': 'dns_db'
    }

    dns_manager = DNSRecordManager(db_config)

    # Start service synchronization and health monitoring
    import threading

    # Start service sync thread
    sync_thread = threading.Thread(target=lambda: [
        time.sleep(10),  # Initial delay
        dns_manager.sync_kubernetes_services()
    ])
    sync_thread.daemon = True
    sync_thread.start()

    # Start health monitoring (blocks)
    dns_manager.monitor_service_health()
```

## Security Hardening and Access Control

### Advanced Access Control Lists

```yaml
# Enhanced security configuration for CoreDNS
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-security-config
  namespace: dns-system
data:
  Corefile: |
    # Security-hardened CoreDNS configuration
    (security-baseline) {
        errors {
            consolidate 5m ".*" warning
        }

        # Comprehensive logging for security auditing
        log {
            class all
            format "{type} {name} {rcode} {>rflags} {>bufsize} {>do} {>id} {remote} {port} {size} {duration}"
        }

        # Health and readiness
        health {
            lameduck 10s
        }
        ready

        # Rate limiting with intelligent thresholds
        ratelimit {
            per_second 100
            per_client 10
            whitelist 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
            blacklist 192.0.2.0/24 203.0.113.128/25
            window 60s
            ipv4_mask 24
            ipv6_mask 64
        }

        # DNS filtering for security
        filter {
            block_type A AAAA
            action drop
            # Block known malicious domains
            file /etc/coredns/blocklist.txt
        }

        # Cache with security considerations
        cache 300 {
            success 10000 300
            denial 5000 60
            # Prevent cache poisoning
            prefetch 25 60s 20%
        }

        prometheus :9153 {
            path /metrics
        }
    }

    # Executive network - highest security
    executive.company.internal:53 {
        # Strict IP-based access control
        acl {
            allow 10.0.1.0/24     # Executive network
            allow 10.0.100.0/24   # IT admin network
            deny all
        }

        import security-baseline

        # Enhanced security logging
        log {
            class all
            format "[EXECUTIVE] {type} {name} {rcode} {remote} {port} {size} {duration}"
        }

        # Executive host mappings
        hosts /etc/coredns/executive-hosts {
            ttl 600
            reload 60s
            fallthrough
        }

        # Secure forwarding to executive DNS
        forward . 10.0.1.253:53 {
            max_concurrent 100
            policy sequential
            health_check 30s
            tls_servername executive-dns.company.internal
        }
    }

    # Finance network - PCI DSS compliance
    finance.company.internal:53 {
        acl {
            allow 10.0.5.0/24     # Finance network
            allow 10.0.100.0/24   # IT admin network
            deny all
        }

        import security-baseline

        # PCI DSS compliant logging
        log {
            class all
            format "[FINANCE] {type} {name} {rcode} {remote} {port} {size} {duration} {>edns0}"
        }

        # Finance-specific host mappings
        hosts /etc/coredns/finance-hosts {
            ttl 300
            reload 30s
            fallthrough
        }

        # Encrypted forwarding
        forward . tls://10.0.5.253:853 {
            tls_servername finance-dns.company.internal
            max_concurrent 200
            policy sequential
            health_check 15s
        }
    }

    # DMZ network - controlled external access
    dmz.company.internal:53 {
        acl {
            allow 203.0.113.0/24  # DMZ network
            allow 198.51.100.0/24 # Partner access
            allow 10.0.100.0/24   # IT admin network
            deny all
        }

        import security-baseline

        # DMZ security filtering
        filter {
            block_type A AAAA
            action refuse
            file /etc/coredns/dmz-blocklist.txt
            # Additional DMZ-specific blocks
            regex ".*\.onion$"
            regex ".*\.bit$"
        }

        # DMZ host mappings
        hosts /etc/coredns/dmz-hosts {
            ttl 120
            reload 20s
            fallthrough
        }

        # DMZ forwarding with monitoring
        forward . 203.0.113.253:53 {
            max_concurrent 500
            policy round_robin
            health_check 10s
        }
    }

    # Development network - restricted access
    dev.company.internal:53 {
        acl {
            allow 192.168.100.0/24  # Dev network
            allow 192.168.101.0/24  # Dev test network
            allow 10.0.100.0/24     # IT admin network
            deny all
        }

        import security-baseline

        # Development-specific rate limiting
        ratelimit {
            per_second 200
            per_client 20
            window 300s
        }

        # Development host mappings
        hosts /etc/coredns/dev-hosts {
            ttl 60
            reload 10s
            fallthrough
        }

        # Development DNS forwarding
        forward . 192.168.100.253:53 {
            max_concurrent 300
            policy sequential
            health_check 5s
        }
    }

    # Guest network - heavily restricted
    guest.company.internal:53 {
        acl {
            allow 172.16.200.0/24   # Guest network
            deny all
        }

        # Enhanced rate limiting for guest access
        ratelimit {
            per_second 20
            per_client 2
            window 3600s
            ipv4_mask 32
        }

        # Aggressive DNS filtering
        filter {
            block_type A AAAA
            action drop
            file /etc/coredns/guest-blocklist.txt
            # Block internal domains
            regex ".*\.company\.internal$"
            regex ".*\.local$"
        }

        # Minimal logging for privacy
        log {
            class denial error
        }

        # Basic cache
        cache 600 {
            success 1000 600
            denial 500 300
        }

        # Restricted forwarding
        forward . 8.8.8.8:53 1.1.1.1:53 {
            max_concurrent 100
            policy random
            health_check 60s
        }
    }

    # Default - most restrictive
    .:53 {
        import security-baseline

        # Default rate limiting
        ratelimit {
            per_second 50
            per_client 5
            window 60s
        }

        # Security filtering
        filter {
            block_type A AAAA
            action refuse
            file /etc/coredns/global-blocklist.txt
        }

        # Default forwarding
        forward . 8.8.8.8:53 1.1.1.1:53 {
            max_concurrent 1000
            policy random
            health_check 30s
        }
    }

---
# Security blocklists
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-blocklists
  namespace: dns-system
data:
  blocklist.txt: |
    # Known malicious domains
    malicious-site.com
    phishing-site.org
    malware-host.net

    # Cryptocurrency mining
    coinhive.com
    jsecoin.com
    cryptoloot.pro

    # Ad networks (optional)
    doubleclick.net
    googleadservices.com
    googlesyndication.com

  dmz-blocklist.txt: |
    # Additional DMZ-specific blocks
    internal-dev.company.com
    test-server.company.com
    staging-api.company.com

  guest-blocklist.txt: |
    # Comprehensive blocks for guest network
    company.internal
    *.company.internal
    localhost
    *.local
    intranet
    *.intranet

    # P2P and file sharing
    thepiratebay.org
    bittorrent.com
    utorrent.com

    # Social media (if policy requires)
    facebook.com
    twitter.com
    instagram.com

  global-blocklist.txt: |
    # Global security blocks
    suspicious-domain.com
    known-bad-actor.org
    malware-distribution.net
```

### DNS Query Monitoring and Threat Detection

```python
#!/usr/bin/env python3
"""
DNS query monitoring and threat detection system
"""

import re
import json
import time
from collections import defaultdict, deque
from typing import Dict, List, Set, Tuple
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class DNSQuery:
    timestamp: datetime
    client_ip: str
    query_type: str
    domain: str
    response_code: str
    response_time: float
    query_size: int

class DNSThreatDetector:
    def __init__(self):
        # Threat detection parameters
        self.max_queries_per_minute = 100
        self.max_unique_domains_per_hour = 500
        self.suspicious_query_threshold = 50

        # Tracking structures
        self.client_queries = defaultdict(lambda: deque(maxlen=1000))
        self.client_domains = defaultdict(lambda: defaultdict(int))
        self.domain_reputation = defaultdict(int)

        # Threat patterns
        self.threat_patterns = self._load_threat_patterns()

        # Alerting thresholds
        self.alert_thresholds = {
            'high_frequency': 200,      # Queries per minute
            'domain_diversity': 1000,   # Unique domains per hour
            'suspicious_patterns': 10,  # Suspicious pattern matches
            'dns_tunneling': 20,       # Long domain queries
            'dga_detection': 15        # Domain generation algorithm detection
        }

    def _load_threat_patterns(self) -> Dict[str, List[str]]:
        """Load DNS threat detection patterns"""
        return {
            'dga_patterns': [
                r'^[a-z]{8,}\.com$',        # Long random domains
                r'^[0-9]{6,}\..*$',         # Numeric domains
                r'^[a-z]{3,}[0-9]{3,}\..*$' # Mixed alphanumeric
            ],
            'dns_tunneling': [
                r'^[a-zA-Z0-9]{30,}\..*$',  # Very long subdomains
                r'^[a-zA-Z0-9\-]{20,}\..*\..*\..*$'  # Deep subdomains
            ],
            'c2_patterns': [
                r'.*\.tk$',                 # Common C2 TLD
                r'.*\.ml$',                 # Common C2 TLD
                r'.*\.ga$',                 # Common C2 TLD
                r'^[0-9]{1,3}-[0-9]{1,3}-[0-9]{1,3}-[0-9]{1,3}\..*$'  # IP-like domains
            ],
            'malware_patterns': [
                r'.*update.*\.exe$',
                r'.*download.*\.zip$',
                r'.*temp.*\.tmp$'
            ]
        }

    def analyze_query(self, query: DNSQuery) -> Dict[str, Any]:
        """Analyze a DNS query for threats"""
        analysis = {
            'timestamp': query.timestamp.isoformat(),
            'client_ip': query.client_ip,
            'domain': query.domain,
            'threat_score': 0,
            'threats_detected': [],
            'recommendations': []
        }

        # Track query for client
        self.client_queries[query.client_ip].append(query)

        # High frequency detection
        recent_queries = self._get_recent_queries(query.client_ip, minutes=1)
        if len(recent_queries) > self.alert_thresholds['high_frequency']:
            analysis['threats_detected'].append('high_frequency_queries')
            analysis['threat_score'] += 30

        # Domain diversity detection
        hourly_domains = self._get_unique_domains_count(query.client_ip, hours=1)
        if hourly_domains > self.alert_thresholds['domain_diversity']:
            analysis['threats_detected'].append('high_domain_diversity')
            analysis['threat_score'] += 25

        # Pattern matching
        pattern_threats = self._detect_pattern_threats(query.domain)
        if pattern_threats:
            analysis['threats_detected'].extend(pattern_threats)
            analysis['threat_score'] += len(pattern_threats) * 15

        # DNS tunneling detection
        if self._detect_dns_tunneling(query.domain, query.query_size):
            analysis['threats_detected'].append('dns_tunneling')
            analysis['threat_score'] += 40

        # DGA detection
        if self._detect_dga(query.domain):
            analysis['threats_detected'].append('domain_generation_algorithm')
            analysis['threat_score'] += 35

        # Failed query analysis
        if query.response_code != 'NOERROR':
            failed_queries = self._count_failed_queries(query.client_ip, minutes=5)
            if failed_queries > 20:
                analysis['threats_detected'].append('excessive_failed_queries')
                analysis['threat_score'] += 20

        # Generate recommendations
        analysis['recommendations'] = self._generate_recommendations(analysis)

        return analysis

    def _get_recent_queries(self, client_ip: str, minutes: int = 1) -> List[DNSQuery]:
        """Get recent queries for a client"""
        cutoff_time = datetime.now() - timedelta(minutes=minutes)
        return [q for q in self.client_queries[client_ip]
                if q.timestamp >= cutoff_time]

    def _get_unique_domains_count(self, client_ip: str, hours: int = 1) -> int:
        """Count unique domains queried by client in time period"""
        cutoff_time = datetime.now() - timedelta(hours=hours)
        unique_domains = set()

        for query in self.client_queries[client_ip]:
            if query.timestamp >= cutoff_time:
                unique_domains.add(query.domain)

        return len(unique_domains)

    def _detect_pattern_threats(self, domain: str) -> List[str]:
        """Detect threat patterns in domain"""
        threats = []

        for threat_type, patterns in self.threat_patterns.items():
            for pattern in patterns:
                if re.match(pattern, domain):
                    threats.append(threat_type)
                    break

        return threats

    def _detect_dns_tunneling(self, domain: str, query_size: int) -> bool:
        """Detect potential DNS tunneling"""
        # Long subdomain names
        if len(domain) > 50:
            return True

        # Many subdomains
        if domain.count('.') > 4:
            return True

        # Large query size
        if query_size > 512:
            return True

        # Base64-like patterns in subdomain
        subdomain = domain.split('.')[0]
        if len(subdomain) > 20 and re.match(r'^[A-Za-z0-9+/=]+$', subdomain):
            return True

        return False

    def _detect_dga(self, domain: str) -> bool:
        """Detect Domain Generation Algorithm patterns"""
        domain_part = domain.split('.')[0]

        # Very long domain names
        if len(domain_part) > 15:
            return True

        # High consonant to vowel ratio
        consonants = sum(1 for c in domain_part.lower()
                        if c.isalpha() and c not in 'aeiou')
        vowels = sum(1 for c in domain_part.lower()
                    if c in 'aeiou')

        if vowels > 0 and consonants / vowels > 3:
            return True

        # Entropy analysis (simplified)
        unique_chars = len(set(domain_part))
        if len(domain_part) > 8 and unique_chars / len(domain_part) > 0.8:
            return True

        return False

    def _count_failed_queries(self, client_ip: str, minutes: int = 5) -> int:
        """Count failed queries for client in time period"""
        cutoff_time = datetime.now() - timedelta(minutes=minutes)
        failed_count = 0

        for query in self.client_queries[client_ip]:
            if (query.timestamp >= cutoff_time and
                query.response_code not in ['NOERROR', 'NXDOMAIN']):
                failed_count += 1

        return failed_count

    def _generate_recommendations(self, analysis: Dict[str, Any]) -> List[str]:
        """Generate security recommendations based on analysis"""
        recommendations = []
        threats = analysis['threats_detected']

        if 'high_frequency_queries' in threats:
            recommendations.append("Rate limit client IP address")
            recommendations.append("Investigate client for potential DDoS activity")

        if 'high_domain_diversity' in threats:
            recommendations.append("Monitor client for data exfiltration")
            recommendations.append("Consider temporary access restriction")

        if 'dns_tunneling' in threats:
            recommendations.append("Block client immediately - DNS tunneling detected")
            recommendations.append("Analyze network traffic for data exfiltration")

        if 'domain_generation_algorithm' in threats:
            recommendations.append("Block domain family")
            recommendations.append("Update malware detection signatures")

        if any('c2_patterns' in threat for threat in threats):
            recommendations.append("Block C2 communication channel")
            recommendations.append("Initiate incident response procedure")

        if analysis['threat_score'] > 50:
            recommendations.append("IMMEDIATE ACTION REQUIRED - High threat score")
            recommendations.append("Escalate to security team")

        return recommendations

    def generate_threat_report(self, time_period: timedelta = timedelta(hours=1)) -> Dict[str, Any]:
        """Generate comprehensive threat report"""
        cutoff_time = datetime.now() - time_period

        # Analyze all recent queries
        all_analyses = []
        threat_summary = defaultdict(int)
        high_risk_clients = set()

        for client_ip, queries in self.client_queries.items():
            for query in queries:
                if query.timestamp >= cutoff_time:
                    analysis = self.analyze_query(query)
                    all_analyses.append(analysis)

                    # Update threat summary
                    for threat in analysis['threats_detected']:
                        threat_summary[threat] += 1

                    # Track high-risk clients
                    if analysis['threat_score'] > 30:
                        high_risk_clients.add(client_ip)

        # Generate report
        report = {
            'report_period': {
                'start': cutoff_time.isoformat(),
                'end': datetime.now().isoformat(),
                'duration_hours': time_period.total_seconds() / 3600
            },
            'summary': {
                'total_queries_analyzed': len(all_analyses),
                'threats_detected': dict(threat_summary),
                'high_risk_clients': list(high_risk_clients),
                'total_threat_score': sum(a['threat_score'] for a in all_analyses)
            },
            'top_threats': self._get_top_threats(all_analyses),
            'recommendations': self._generate_global_recommendations(threat_summary),
            'detailed_analyses': [a for a in all_analyses if a['threat_score'] > 20]
        }

        return report

    def _get_top_threats(self, analyses: List[Dict[str, Any]], top_n: int = 10) -> List[Dict[str, Any]]:
        """Get top threats by score"""
        sorted_analyses = sorted(analyses, key=lambda x: x['threat_score'], reverse=True)
        return sorted_analyses[:top_n]

    def _generate_global_recommendations(self, threat_summary: Dict[str, int]) -> List[str]:
        """Generate global security recommendations"""
        recommendations = []

        total_threats = sum(threat_summary.values())

        if total_threats > 100:
            recommendations.append("CRITICAL: High volume of DNS threats detected")
            recommendations.append("Consider implementing DNS firewall")

        if threat_summary.get('dns_tunneling', 0) > 5:
            recommendations.append("Multiple DNS tunneling attempts - investigate network")
            recommendations.append("Implement deep packet inspection")

        if threat_summary.get('domain_generation_algorithm', 0) > 10:
            recommendations.append("DGA activity detected - update anti-malware systems")
            recommendations.append("Consider sinkholing suspicious domains")

        if threat_summary.get('high_frequency_queries', 0) > 20:
            recommendations.append("Multiple high-frequency query sources")
            recommendations.append("Review rate limiting configuration")

        return recommendations

if __name__ == "__main__":
    detector = DNSThreatDetector()

    # Example usage
    sample_query = DNSQuery(
        timestamp=datetime.now(),
        client_ip="192.168.1.100",
        query_type="A",
        domain="aabcdefghijklmnopqrstuvwxyz123.com",
        response_code="NOERROR",
        response_time=0.15,
        query_size=128
    )

    analysis = detector.analyze_query(sample_query)
    print(json.dumps(analysis, indent=2))

    # Generate threat report
    report = detector.generate_threat_report()
    print(json.dumps(report, indent=2))
```

## Conclusion

Advanced DNS forwarding with CoreDNS enables organizations to implement sophisticated network architectures that support complex business requirements while maintaining security and performance standards. The configurations and patterns presented in this guide demonstrate how split-horizon DNS, conditional forwarding, and intelligent threat detection can be integrated to create enterprise-grade DNS infrastructure.

Key success factors include careful network segmentation design, comprehensive access control implementation, proactive threat monitoring, and robust operational procedures. Organizations implementing these patterns can expect significant improvements in DNS security posture, network performance optimization, and operational visibility across complex multi-domain environments.

The combination of CoreDNS's advanced plugin ecosystem, database-backed dynamic record management, and intelligent threat detection provides a comprehensive foundation for modern enterprise DNS architecture capable of supporting evolving security requirements and business growth.