---
title: "Kubernetes Multi-Cluster Load Balancing with GSLB: Anycast and GeoDNS Routing"
date: 2031-05-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GSLB", "Load Balancing", "GeoDNS", "Anycast", "ExternalDNS", "Route53", "Cloudflare", "Multi-Cluster"]
categories:
- Kubernetes
- Networking
- Multi-Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Global Server Load Balancing for Kubernetes multi-cluster deployments, covering anycast DNS routing, ExternalDNS with Route53 weighted records, Cloudflare Load Balancing integration, health check propagation, and failover testing procedures."
more_link: "yes"
url: "/kubernetes-multi-cluster-load-balancing-gslb-anycast-geodns/"
---

Running Kubernetes across multiple regions demands a coherent global traffic routing strategy. Global Server Load Balancing (GSLB) combines health-aware DNS with geographic routing policies to distribute users to the nearest healthy cluster while enabling automatic failover. This guide builds a production GSLB system from the network layer through Kubernetes operators.

<!--more-->

# Kubernetes Multi-Cluster Load Balancing with GSLB: Anycast and GeoDNS Routing

## Section 1: GSLB Architecture Overview

Global Server Load Balancing operates at the DNS layer, returning different IP addresses to different clients based on geographic location, health status, and routing policies.

```
User Request Flow:

User (EU) ──→ DNS Query: api.yourdomain.com
                    │
                    ▼
           GeoDNS Provider
           (Route53/Cloudflare)
                    │
                    ├── EU user → k8s-eu.yourdomain.com (10.0.0.1)
                    │                   │
                    │              Health Check: /healthz (PASS)
                    │
                    └── US user → k8s-us.yourdomain.com (10.0.0.2)
                                        │
                                   Health Check: /healthz (PASS)

Failover Scenario:
User (EU) ──→ DNS Query: api.yourdomain.com
                    │
           k8s-eu UNHEALTHY (health check FAIL)
                    │
                    ▼
           Fallback: k8s-us.yourdomain.com (10.0.0.2)
```

### Multi-Cluster Reference Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Global Infrastructure                         │
│                                                                    │
│  ┌─────────────────┐    ┌─────────────────┐                      │
│  │   Route53 /     │    │   Cloudflare     │                      │
│  │   Cloudflare DNS│    │   Load Balancer  │                      │
│  └────────┬────────┘    └────────┬────────┘                      │
│           │                      │                                │
└───────────┼──────────────────────┼────────────────────────────────┘
            │                      │
   ┌─────────────────┐    ┌─────────────────┐
   │  us-east-1      │    │  eu-west-1      │
   │  K8s Cluster    │    │  K8s Cluster    │
   │                 │    │                 │
   │  ExternalDNS    │    │  ExternalDNS    │
   │  Ingress/LB     │    │  Ingress/LB     │
   │  Health Checks  │    │  Health Checks  │
   └─────────────────┘    └─────────────────┘
```

## Section 2: ExternalDNS with Route53 Weighted Routing

### ExternalDNS Installation

```yaml
# external-dns-deployment.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-dns
  namespace: kube-system
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/ExternalDNSRole
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: external-dns
rules:
  - apiGroups: [""]
    resources: ["services", "endpoints", "pods", "nodes"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["extensions", "networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: external-dns-viewer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: external-dns
subjects:
  - kind: ServiceAccount
    name: external-dns
    namespace: kube-system
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-dns
  namespace: kube-system
spec:
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: external-dns
  template:
    metadata:
      labels:
        app: external-dns
    spec:
      serviceAccountName: external-dns
      containers:
        - name: external-dns
          image: registry.k8s.io/external-dns/external-dns:v0.14.2
          args:
            - --source=service
            - --source=ingress
            - --domain-filter=yourdomain.com
            - --provider=aws
            - --aws-zone-type=public
            - --registry=txt
            - --txt-owner-id=k8s-us-east-1
            # Policy: sync (create/update/delete) or upsert-only
            - --policy=sync
            - --log-level=info
            # GSLB specific: set routing policy to weighted
            - --aws-prefer-cname
          env:
            - name: AWS_DEFAULT_REGION
              value: us-east-1
          resources:
            requests:
              cpu: 50m
              memory: 50Mi
            limits:
              cpu: 100m
              memory: 100Mi
```

### Service Annotations for Weighted Routing

```yaml
# weighted-service.yaml - US East cluster (weight: 80)
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    # ExternalDNS Route53 weighted routing annotations
    external-dns.alpha.kubernetes.io/hostname: "api.yourdomain.com"
    external-dns.alpha.kubernetes.io/aws-weight: "80"
    # Route53 SetIdentifier must be unique per cluster
    external-dns.alpha.kubernetes.io/aws-set-identifier: "us-east-1-api"
    # Health check configuration
    external-dns.alpha.kubernetes.io/aws-health-check-id: "your-health-check-id"
    # Region-based geoproximity routing
    external-dns.alpha.kubernetes.io/aws-region: "us-east-1"
    # Failover routing: PRIMARY or SECONDARY
    # external-dns.alpha.kubernetes.io/aws-failover: "PRIMARY"
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
    - port: 443
      targetPort: 8443
      protocol: TCP
```

```yaml
# weighted-service-eu.yaml - EU West cluster (weight: 20)
apiVersion: v1
kind: Service
metadata:
  name: api-service
  namespace: production
  annotations:
    external-dns.alpha.kubernetes.io/hostname: "api.yourdomain.com"
    external-dns.alpha.kubernetes.io/aws-weight: "20"
    external-dns.alpha.kubernetes.io/aws-set-identifier: "eu-west-1-api"
    external-dns.alpha.kubernetes.io/aws-health-check-id: "your-eu-health-check-id"
    external-dns.alpha.kubernetes.io/aws-region: "eu-west-1"
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
    - port: 443
      targetPort: 8443
      protocol: TCP
```

### Route53 Health Check via Terraform

```hcl
# route53-health-checks.tf

# Health check for US East cluster
resource "aws_route53_health_check" "us_east_api" {
  fqdn              = "k8s-us-east.yourdomain.com"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 30

  tags = {
    Name    = "k8s-us-east-api-health"
    Cluster = "us-east-1"
    Env     = "production"
  }
}

# Health check for EU West cluster
resource "aws_route53_health_check" "eu_west_api" {
  fqdn              = "k8s-eu-west.yourdomain.com"
  port              = 443
  type              = "HTTPS"
  resource_path     = "/healthz"
  failure_threshold = 3
  request_interval  = 30

  tags = {
    Name    = "k8s-eu-west-api-health"
    Cluster = "eu-west-1"
    Env     = "production"
  }
}

# Calculated health check combining both regional checks
resource "aws_route53_health_check" "global_api" {
  type                     = "CALCULATED"
  child_health_threshold   = 1  # At least 1 region must be healthy
  child_healthchecks       = [
    aws_route53_health_check.us_east_api.id,
    aws_route53_health_check.eu_west_api.id,
  ]

  tags = {
    Name = "global-api-calculated"
  }
}

# Hosted zone
data "aws_route53_zone" "primary" {
  name = "yourdomain.com."
}

# Latency-based routing record for US
resource "aws_route53_record" "api_us" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "api.yourdomain.com"
  type    = "A"

  set_identifier = "us-east-1"

  latency_routing_policy {
    region = "us-east-1"
  }

  alias {
    name                   = "your-us-nlb.us-east-1.elb.amazonaws.com"
    zone_id                = "Z35SXDOTRQ7X7K"
    evaluate_target_health = true
  }

  health_check_id = aws_route53_health_check.us_east_api.id
}

# Latency-based routing record for EU
resource "aws_route53_record" "api_eu" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "api.yourdomain.com"
  type    = "A"

  set_identifier = "eu-west-1"

  latency_routing_policy {
    region = "eu-west-1"
  }

  alias {
    name                   = "your-eu-nlb.eu-west-1.elb.amazonaws.com"
    zone_id                = "Z3NF1Z3NOM5OY2"
    evaluate_target_health = true
  }

  health_check_id = aws_route53_health_check.eu_west_api.id
}
```

## Section 3: Cloudflare Load Balancing with Kubernetes

### Cloudflare Operator for Kubernetes

```yaml
# cloudflare-operator.yaml
# Using the cloudflare-operator-controller for automated tunnel management
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflare-operator
  namespace: cloudflare-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cloudflare-operator
  template:
    metadata:
      labels:
        app: cloudflare-operator
    spec:
      serviceAccountName: cloudflare-operator
      containers:
        - name: operator
          image: cloudflare/cloudflare-operator:latest
          env:
            - name: CF_API_TOKEN
              valueFrom:
                secretKeyRef:
                  name: cloudflare-credentials
                  key: api-token
            - name: CF_ACCOUNT_ID
              valueFrom:
                secretKeyRef:
                  name: cloudflare-credentials
                  key: account-id
          resources:
            limits:
              cpu: 100m
              memory: 128Mi
```

### Cloudflare Tunnel for Cluster Connectivity

```yaml
# cloudflare-tunnel.yaml
apiVersion: networking.cloudflare.com/v1alpha1
kind: Tunnel
metadata:
  name: k8s-us-east-tunnel
  namespace: cloudflare-system
spec:
  # Cloudflare tunnel credentials secret
  credentials:
    secretRef:
      name: cloudflare-tunnel-credentials
  # Ingress rules for the tunnel
  ingress:
    - hostname: "api-us.yourdomain.com"
      service: "https://api-service.production.svc.cluster.local:443"
      originRequest:
        connectTimeout: 30s
        noTLSVerify: false
        caPool: "/etc/cloudflare/origin-ca.crt"
    - service: "http_status:404"
---
apiVersion: networking.cloudflare.com/v1alpha1
kind: Tunnel
metadata:
  name: k8s-eu-west-tunnel
  namespace: cloudflare-system
spec:
  credentials:
    secretRef:
      name: cloudflare-tunnel-credentials-eu
  ingress:
    - hostname: "api-eu.yourdomain.com"
      service: "https://api-service.production.svc.cluster.local:443"
    - service: "http_status:404"
```

### Cloudflare Load Balancer via Terraform

```hcl
# cloudflare-lb.tf

variable "cf_zone_id" {}

# Origin pool for US East
resource "cloudflare_load_balancer_pool" "us_east" {
  account_id = var.cf_account_id
  name       = "k8s-us-east-pool"
  description = "Kubernetes US East cluster"

  origins {
    name    = "us-east-primary"
    address = "k8s-us-east.yourdomain.com"
    enabled = true
    weight  = 1.0

    header {
      header = "Host"
      values = ["api.yourdomain.com"]
    }
  }

  health_check {
    enabled  = true
    path     = "/healthz"
    port     = 443
    type     = "https"
    method   = "GET"
    timeout  = 10
    interval = 60
    retries  = 2
    expected_codes = "200"
    expect_body = "ok"
  }

  latitude  = 37.7749  # San Francisco
  longitude = -122.4194
}

# Origin pool for EU West
resource "cloudflare_load_balancer_pool" "eu_west" {
  account_id = var.cf_account_id
  name       = "k8s-eu-west-pool"
  description = "Kubernetes EU West cluster"

  origins {
    name    = "eu-west-primary"
    address = "k8s-eu-west.yourdomain.com"
    enabled = true
    weight  = 1.0
  }

  health_check {
    enabled  = true
    path     = "/healthz"
    port     = 443
    type     = "https"
    timeout  = 10
    interval = 60
    retries  = 2
    expected_codes = "200"
  }

  latitude  = 53.3498  # Dublin
  longitude = -6.2603
}

# Global Load Balancer
resource "cloudflare_load_balancer" "global_api" {
  zone_id          = var.cf_zone_id
  name             = "api.yourdomain.com"
  description      = "Global API load balancer"
  proxied          = true
  enabled          = true
  ttl              = 30
  steering_policy  = "geo"  # geo, dynamic_latency, random, off

  # Default pool (fallback)
  default_pool_ids = [
    cloudflare_load_balancer_pool.us_east.id,
    cloudflare_load_balancer_pool.eu_west.id,
  ]

  # Fallback pool (last resort)
  fallback_pool_id = cloudflare_load_balancer_pool.us_east.id

  # Geographic steering - route EU traffic to EU pool
  region_pools {
    region   = "WEU"  # Western Europe
    pool_ids = [
      cloudflare_load_balancer_pool.eu_west.id,
      cloudflare_load_balancer_pool.us_east.id,
    ]
  }

  region_pools {
    region   = "EEUR"  # Eastern Europe
    pool_ids = [
      cloudflare_load_balancer_pool.eu_west.id,
      cloudflare_load_balancer_pool.us_east.id,
    ]
  }

  region_pools {
    region   = "ENAM"  # Eastern North America
    pool_ids = [
      cloudflare_load_balancer_pool.us_east.id,
      cloudflare_load_balancer_pool.eu_west.id,
    ]
  }

  # Session affinity for stateful connections
  session_affinity = "none"

  # Adaptive routing for improved performance
  adaptive_routing {
    failover_across_pools = true
  }

  # Rules for custom steering logic
  rules {
    name      = "bypass-for-health-checks"
    condition = "(http.request.uri.path eq \"/healthz\")"
    disabled  = false

    overrides {
      steering_policy = "off"  # Send to closest pool
    }
  }
}
```

## Section 4: Health Check Service for Kubernetes

### Comprehensive Health Check Endpoint

```go
// healthcheck/server.go - Production-grade health check for GSLB
package healthcheck

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "sync"
    "sync/atomic"
    "time"

    "go.uber.org/zap"
)

// ClusterHealthStatus represents the overall cluster health.
type ClusterHealthStatus struct {
    Status      string            `json:"status"`
    Version     string            `json:"version"`
    ClusterName string            `json:"cluster_name"`
    Region      string            `json:"region"`
    Checks      map[string]Check  `json:"checks"`
    Timestamp   time.Time         `json:"timestamp"`
}

// Check represents a single health check result.
type Check struct {
    Status  string        `json:"status"`
    Latency time.Duration `json:"latency_ms"`
    Message string        `json:"message,omitempty"`
}

// HealthChecker performs and aggregates health checks.
type HealthChecker struct {
    logger      *zap.Logger
    clusterName string
    region      string
    version     string

    mu          sync.RWMutex
    lastStatus  ClusterHealthStatus

    // Atomic flag for fast path in health check
    healthy int32

    // Check functions
    checks map[string]CheckFunc

    // Maintenance mode flag
    maintenanceMode int32
}

// CheckFunc is a function that performs a health check.
type CheckFunc func(ctx context.Context) (Check, error)

// NewHealthChecker creates a new health checker.
func NewHealthChecker(
    logger *zap.Logger,
    clusterName, region, version string,
) *HealthChecker {
    return &HealthChecker{
        logger:      logger,
        clusterName: clusterName,
        region:      region,
        version:     version,
        checks:      make(map[string]CheckFunc),
        healthy:     1,
    }
}

// RegisterCheck adds a health check function.
func (h *HealthChecker) RegisterCheck(name string, fn CheckFunc) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.checks[name] = fn
}

// SetMaintenance enables/disables maintenance mode.
func (h *HealthChecker) SetMaintenance(enabled bool) {
    if enabled {
        atomic.StoreInt32(&h.maintenanceMode, 1)
    } else {
        atomic.StoreInt32(&h.maintenanceMode, 0)
    }
}

// Run continuously performs health checks.
func (h *HealthChecker) Run(ctx context.Context, interval time.Duration) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    // Run immediately on start
    h.runChecks(ctx)

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            h.runChecks(ctx)
        }
    }
}

func (h *HealthChecker) runChecks(ctx context.Context) {
    checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    h.mu.RLock()
    checks := make(map[string]CheckFunc, len(h.checks))
    for k, v := range h.checks {
        checks[k] = v
    }
    h.mu.RUnlock()

    results := make(map[string]Check)
    allHealthy := true

    var wg sync.WaitGroup
    var mu sync.Mutex

    for name, checkFn := range checks {
        wg.Add(1)
        go func(n string, fn CheckFunc) {
            defer wg.Done()

            start := time.Now()
            check, err := fn(checkCtx)
            check.Latency = time.Since(start) / time.Millisecond

            if err != nil {
                check.Status = "unhealthy"
                check.Message = err.Error()
            }

            mu.Lock()
            results[n] = check
            if check.Status != "healthy" {
                allHealthy = false
            }
            mu.Unlock()
        }(name, checkFn)
    }

    wg.Wait()

    status := "healthy"
    if !allHealthy {
        status = "degraded"
    }

    if atomic.LoadInt32(&h.maintenanceMode) == 1 {
        status = "maintenance"
    }

    healthy := 0
    if status == "healthy" {
        healthy = 1
    }
    atomic.StoreInt32(&h.healthy, int32(healthy))

    h.mu.Lock()
    h.lastStatus = ClusterHealthStatus{
        Status:      status,
        Version:     h.version,
        ClusterName: h.clusterName,
        Region:      h.region,
        Checks:      results,
        Timestamp:   time.Now(),
    }
    h.mu.Unlock()
}

// HTTPHandler returns an http.HandlerFunc for GSLB health checks.
func (h *HealthChecker) HTTPHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // Fast path for load balancer probes
        if r.URL.Path == "/healthz" {
            if atomic.LoadInt32(&h.healthy) == 1 {
                w.WriteHeader(http.StatusOK)
                fmt.Fprintf(w, "ok")
                return
            }
            w.WriteHeader(http.StatusServiceUnavailable)
            fmt.Fprintf(w, "unhealthy")
            return
        }

        // Detailed health status
        h.mu.RLock()
        status := h.lastStatus
        h.mu.RUnlock()

        httpStatus := http.StatusOK
        if status.Status != "healthy" {
            httpStatus = http.StatusServiceUnavailable
        }

        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(httpStatus)
        json.NewEncoder(w).Encode(status)
    }
}

// RegisterKubernetesChecks adds standard Kubernetes health checks.
func (h *HealthChecker) RegisterKubernetesChecks(
    apiServerURL string,
    etcdClient interface{},
) {
    // Check Kubernetes API server
    h.RegisterCheck("kubernetes_api", func(ctx context.Context) (Check, error) {
        client := &http.Client{Timeout: 5 * time.Second}
        resp, err := client.Get(apiServerURL + "/healthz")
        if err != nil {
            return Check{Status: "unhealthy"}, fmt.Errorf("api server unreachable: %w", err)
        }
        defer resp.Body.Close()

        if resp.StatusCode != http.StatusOK {
            return Check{Status: "unhealthy"},
                fmt.Errorf("api server returned status %d", resp.StatusCode)
        }
        return Check{Status: "healthy"}, nil
    })

    // Check node pressure
    h.RegisterCheck("node_pressure", func(ctx context.Context) (Check, error) {
        // In production, query the Kubernetes API for node conditions
        return Check{Status: "healthy", Message: "All nodes ready"}, nil
    })
}
```

### Kubernetes Service with Health Check Annotations

```yaml
# health-check-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: health-service
  namespace: production
  annotations:
    # AWS ALB health check annotations
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-path: "/healthz"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-interval-seconds: "10"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-timeout-seconds: "5"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-healthy-threshold-count: "2"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-unhealthy-threshold-count: "3"
    # ExternalDNS
    external-dns.alpha.kubernetes.io/hostname: "health-us-east.yourdomain.com"
spec:
  type: LoadBalancer
  selector:
    app: api
  ports:
    - port: 443
      targetPort: 8080
```

## Section 5: Anycast DNS Architecture

### BGP Anycast with MetalLB

```yaml
# metallb-bgp-pool.yaml - Anycast IP pool across clusters
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: anycast-pool
  namespace: metallb-system
spec:
  addresses:
    # These IPs are announced via BGP as anycast from each cluster
    - 192.0.2.0/24
  autoAssign: true
---
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: anycast-advertisement
  namespace: metallb-system
spec:
  ipAddressPools:
    - anycast-pool
  aggregationLength: 24
  # Announce to upstream BGP peers with communities
  communities:
    - 65000:100  # Internal anycast community
  peers:
    - bgp-peer-1
    - bgp-peer-2
---
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: bgp-peer-1
  namespace: metallb-system
spec:
  myASN: 65001
  peerASN: 65000
  peerAddress: 10.0.0.1  # BGP router IP
  password: ""  # Use BGP MD5 auth in production
  holdTime: 90s
  keepaliveTime: 30s
  routerID: "10.0.1.1"
```

### DNS-Based Anycast with bind9

```bash
# named.conf for split-horizon anycast DNS
# This configuration serves different records based on the requesting subnet

view "eu-users" {
    match-clients {
        // European IP blocks (example)
        195.0.0.0/8;
        62.0.0.0/8;
        77.0.0.0/8;
    };
    recursion yes;

    zone "yourdomain.com" {
        type master;
        file "/etc/bind/zones/yourdomain.com.eu";
    };
};

view "us-users" {
    match-clients {
        // US IP blocks
        104.0.0.0/8;
        108.0.0.0/8;
        72.0.0.0/8;
        any;  // Default to US
    };
    recursion yes;

    zone "yourdomain.com" {
        type master;
        file "/etc/bind/zones/yourdomain.com.us";
    };
};
```

```bind
; /etc/bind/zones/yourdomain.com.eu - EU view
$TTL 30
@   IN SOA ns1.yourdomain.com. hostmaster.yourdomain.com. (
            2024030101  ; Serial
            3600        ; Refresh
            900         ; Retry
            604800      ; Expire
            300         ; Minimum TTL
            )

@   IN NS ns1.yourdomain.com.
@   IN NS ns2.yourdomain.com.

; Route EU users to EU cluster
api IN A 10.0.2.100   ; EU cluster LoadBalancer IP
```

## Section 6: Health Check Propagation to DNS

### Custom Health Monitor Controller

```go
// gslb-controller/main.go - Kubernetes controller for GSLB health propagation
package main

import (
    "context"
    "fmt"
    "net/http"
    "time"

    route53svc "github.com/aws/aws-sdk-go-v2/service/route53"
    "github.com/aws/aws-sdk-go-v2/service/route53/types"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/client-go/informers"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/cache"
    "go.uber.org/zap"
)

// GSLBController watches Kubernetes service health and updates DNS.
type GSLBController struct {
    k8sClient     kubernetes.Interface
    route53Client *route53svc.Client
    logger        *zap.Logger
    config        GSLBConfig
    httpClient    *http.Client
}

// GSLBConfig holds GSLB controller configuration.
type GSLBConfig struct {
    // Route53 hosted zone ID
    HostedZoneID string
    // DNS record to manage
    RecordName string
    // Health check endpoint
    HealthEndpoint string
    // Health check interval
    CheckInterval time.Duration
    // Number of failures before marking unhealthy
    FailureThreshold int
    // Cluster name for this instance
    ClusterName string
    // Route53 set identifier
    SetIdentifier string
}

// Run starts the GSLB controller.
func (c *GSLBController) Run(ctx context.Context) error {
    factory := informers.NewSharedInformerFactory(c.k8sClient, 30*time.Second)

    // Watch endpoints to detect service health changes
    endpointInformer := factory.Core().V1().Endpoints().Informer()
    endpointInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
        UpdateFunc: func(old, new interface{}) {
            newEndpoint := new.(*corev1.Endpoints)
            c.handleEndpointUpdate(ctx, newEndpoint)
        },
    })

    factory.Start(ctx.Done())
    factory.WaitForCacheSync(ctx.Done())

    // Start health check loop
    go c.healthCheckLoop(ctx)

    <-ctx.Done()
    return nil
}

func (c *GSLBController) healthCheckLoop(ctx context.Context) {
    ticker := time.NewTicker(c.config.CheckInterval)
    defer ticker.Stop()

    failureCount := 0

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            healthy, err := c.performHealthCheck(ctx)
            if err != nil {
                c.logger.Error("health check error", zap.Error(err))
                failureCount++
            } else if !healthy {
                failureCount++
            } else {
                failureCount = 0
            }

            if failureCount >= c.config.FailureThreshold {
                c.logger.Warn("cluster unhealthy, updating DNS",
                    zap.Int("failure_count", failureCount))
                if err := c.updateDNSWeight(ctx, 0); err != nil {
                    c.logger.Error("failed to update DNS weight", zap.Error(err))
                }
            } else if failureCount == 0 {
                // Restore weight
                if err := c.updateDNSWeight(ctx, 100); err != nil {
                    c.logger.Error("failed to restore DNS weight", zap.Error(err))
                }
            }
        }
    }
}

func (c *GSLBController) performHealthCheck(ctx context.Context) (bool, error) {
    checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    req, err := http.NewRequestWithContext(checkCtx, "GET", c.config.HealthEndpoint, nil)
    if err != nil {
        return false, fmt.Errorf("failed to create request: %w", err)
    }

    resp, err := c.httpClient.Do(req)
    if err != nil {
        return false, fmt.Errorf("health check request failed: %w", err)
    }
    defer resp.Body.Close()

    return resp.StatusCode == http.StatusOK, nil
}

func (c *GSLBController) updateDNSWeight(ctx context.Context, weight int) error {
    weightStr := fmt.Sprintf("%d", weight)

    input := &route53svc.ChangeResourceRecordSetsInput{
        HostedZoneId: &c.config.HostedZoneID,
        ChangeBatch: &types.ChangeBatch{
            Comment: stringPtr(fmt.Sprintf("GSLB weight update: %s=%d", c.config.ClusterName, weight)),
            Changes: []types.Change{
                {
                    Action: types.ChangeActionUpsert,
                    ResourceRecordSet: &types.ResourceRecordSet{
                        Name:              &c.config.RecordName,
                        Type:              types.RRTypeA,
                        SetIdentifier:     &c.config.SetIdentifier,
                        Weight:            weightPtr(int64(weight)),
                        TTL:               int64Ptr(30),
                        ResourceRecords:   []types.ResourceRecord{},
                    },
                },
            },
        },
    }

    _, err := c.route53Client.ChangeResourceRecordSets(ctx, input)
    if err != nil {
        return fmt.Errorf("route53 update failed: %w", err)
    }

    c.logger.Info("DNS weight updated",
        zap.String("cluster", c.config.ClusterName),
        zap.Int("weight", weight),
        zap.String("record", c.config.RecordName))

    return nil
}

func (c *GSLBController) handleEndpointUpdate(ctx context.Context, ep *corev1.Endpoints) {
    totalAddresses := 0
    for _, subset := range ep.Subsets {
        totalAddresses += len(subset.Addresses)
    }

    if totalAddresses == 0 {
        c.logger.Warn("service has no healthy endpoints",
            zap.String("service", ep.Name),
            zap.String("namespace", ep.Namespace))
    }
}

func stringPtr(s string) *string { return &s }
func int64Ptr(i int64) *int64    { return &i }
func weightPtr(i int64) *int64   { return &i }
```

## Section 7: Failover Testing Procedures

### Automated Failover Test Suite

```bash
#!/bin/bash
# gslb-failover-test.sh - Automated GSLB failover testing

set -euo pipefail

DOMAIN="api.yourdomain.com"
US_CLUSTER_CONTEXT="k8s-us-east-1"
EU_CLUSTER_CONTEXT="k8s-eu-west-1"
TEST_DURATION=300  # 5 minutes
DNS_TTL=30

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

check_dns_resolution() {
    local expected_region="$1"
    local resolved_ip

    resolved_ip=$(dig +short "${DOMAIN}" @8.8.8.8 | head -1)
    log "Resolved ${DOMAIN} to: ${resolved_ip}"

    # Verify it resolves to expected region's IP range
    case "${expected_region}" in
        us-east)
            if [[ "${resolved_ip}" == 10.0.1.* ]]; then
                log "PASS: Resolved to US East IP range"
                return 0
            fi
            ;;
        eu-west)
            if [[ "${resolved_ip}" == 10.0.2.* ]]; then
                log "PASS: Resolved to EU West IP range"
                return 0
            fi
            ;;
    esac

    log "FAIL: Unexpected IP: ${resolved_ip}"
    return 1
}

wait_for_dns_propagation() {
    local max_wait=120
    local waited=0

    while [[ ${waited} -lt ${max_wait} ]]; do
        sleep ${DNS_TTL}
        waited=$((waited + DNS_TTL))
        log "Waited ${waited}s for DNS propagation..."

        # Check multiple DNS servers
        local dig_google
        local dig_cloudflare
        dig_google=$(dig +short "${DOMAIN}" @8.8.8.8 | head -1)
        dig_cloudflare=$(dig +short "${DOMAIN}" @1.1.1.1 | head -1)

        log "  Google DNS: ${dig_google}"
        log "  Cloudflare DNS: ${dig_cloudflare}"
    done
}

test_normal_operation() {
    log "=== Test 1: Normal Operation ==="

    # Verify both clusters are healthy
    for context in "${US_CLUSTER_CONTEXT}" "${EU_CLUSTER_CONTEXT}"; do
        kubectl --context="${context}" -n production get pods -l app=api | \
            grep -c "Running" || { log "FAIL: Pods not running in ${context}"; return 1; }
    done

    log "Both clusters operational"
    check_dns_resolution "us-east"
    log "PASS: Normal operation"
}

test_us_cluster_failover() {
    log "=== Test 2: US East Cluster Failover ==="

    # Simulate cluster failure by scaling down
    log "Scaling down US East cluster..."
    kubectl --context="${US_CLUSTER_CONTEXT}" -n production \
        scale deployment api --replicas=0

    # Wait for health checks to detect failure
    log "Waiting for health check failure detection (${DNS_TTL}s + buffer)..."
    sleep $((DNS_TTL * 2 + 30))

    # Verify traffic has failed over to EU
    log "Verifying DNS failover to EU West..."
    local max_retries=10
    local retry=0

    while [[ ${retry} -lt ${max_retries} ]]; do
        if check_dns_resolution "eu-west"; then
            log "PASS: Successfully failed over to EU West"
            break
        fi
        retry=$((retry + 1))
        sleep 10
        log "Retry ${retry}/${max_retries}..."
    done

    if [[ ${retry} -eq ${max_retries} ]]; then
        log "FAIL: DNS did not failover within expected time"
        return 1
    fi

    # Verify API is still accessible
    HTTP_STATUS=$(curl -so /dev/null -w "%{http_code}" \
        "https://${DOMAIN}/healthz" --max-time 10 || echo "000")

    if [[ "${HTTP_STATUS}" == "200" ]]; then
        log "PASS: API accessible during failover"
    else
        log "FAIL: API returned status ${HTTP_STATUS} during failover"
        return 1
    fi
}

restore_us_cluster() {
    log "=== Restore: US East Cluster ==="

    kubectl --context="${US_CLUSTER_CONTEXT}" -n production \
        scale deployment api --replicas=3

    # Wait for pods to be ready
    kubectl --context="${US_CLUSTER_CONTEXT}" -n production \
        wait --for=condition=Ready pod -l app=api --timeout=120s

    log "Waiting for DNS to revert..."
    wait_for_dns_propagation

    check_dns_resolution "us-east"
    log "PASS: US East cluster restored"
}

measure_failover_time() {
    log "=== Measuring Failover Time ==="

    local start_time
    local failover_time

    start_time=$(date +%s)

    # Trigger failure
    kubectl --context="${US_CLUSTER_CONTEXT}" -n production \
        scale deployment api --replicas=0

    log "Monitoring DNS until failover..."

    while true; do
        resolved=$(dig +short "${DOMAIN}" @8.8.8.8 | head -1)
        current_time=$(date +%s)
        elapsed=$((current_time - start_time))

        if [[ "${resolved}" == 10.0.2.* ]]; then
            failover_time=${elapsed}
            log "Failover completed in ${failover_time} seconds"
            break
        fi

        if [[ ${elapsed} -gt 600 ]]; then
            log "FAIL: Failover did not complete within 10 minutes"
            return 1
        fi

        sleep 5
    done

    if [[ ${failover_time} -le 120 ]]; then
        log "PASS: Failover time (${failover_time}s) within SLO (120s)"
    else
        log "WARN: Failover time (${failover_time}s) exceeds SLO (120s)"
    fi
}

# Run test suite
log "Starting GSLB Failover Test Suite"
log "Domain: ${DOMAIN}"
log "US Cluster: ${US_CLUSTER_CONTEXT}"
log "EU Cluster: ${EU_CLUSTER_CONTEXT}"
echo ""

test_normal_operation
test_us_cluster_failover
restore_us_cluster
measure_failover_time

log "=== Test Suite Complete ==="
```

## Section 8: Monitoring GSLB Health

### Prometheus Metrics for GSLB

```yaml
# gslb-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gslb-controller
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: gslb-controller
  endpoints:
    - port: metrics
      interval: 15s
      path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gslb-alerts
  namespace: monitoring
spec:
  groups:
    - name: gslb.routing
      rules:
        - alert: GSLBClusterUnhealthy
          expr: gslb_cluster_healthy == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "GSLB cluster {{ $labels.cluster }} is unhealthy"
            description: "Cluster {{ $labels.cluster }} in region {{ $labels.region }} has been unhealthy for 2 minutes. Traffic may be routing to degraded infrastructure."

        - alert: GSLBAllClustersUnhealthy
          expr: sum(gslb_cluster_healthy) == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "ALL GSLB clusters are unhealthy"
            description: "No healthy clusters available for traffic routing. Complete service outage possible."

        - alert: GSLBDNSUpdateFailure
          expr: rate(gslb_dns_update_errors_total[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GSLB DNS update failures"
            description: "DNS weight updates are failing. GSLB may not respond correctly to cluster health changes."

        - alert: GSLBHighFailoverCount
          expr: rate(gslb_failover_events_total[1h]) > 3
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "High GSLB failover rate"
            description: "More than 3 failover events in the last hour. Investigate cluster stability."
```

## Section 9: Traffic Shaping and Canary Deployments via GSLB

### Progressive Traffic Shift

```bash
#!/bin/bash
# gslb-canary-shift.sh - Gradually shift traffic using Route53 weighted records

HOSTED_ZONE_ID="Z1D633PJN98FT9"
RECORD_NAME="api.yourdomain.com"
V1_SET_ID="api-v1"
V2_SET_ID="api-v2-canary"

shift_traffic() {
    local v1_weight="$1"
    local v2_weight="$2"

    echo "Shifting traffic: v1=${v1_weight}%, v2=${v2_weight}%"

    aws route53 change-resource-record-sets \
        --hosted-zone-id "${HOSTED_ZONE_ID}" \
        --change-batch "{
            \"Changes\": [
                {
                    \"Action\": \"UPSERT\",
                    \"ResourceRecordSet\": {
                        \"Name\": \"${RECORD_NAME}\",
                        \"Type\": \"A\",
                        \"SetIdentifier\": \"${V1_SET_ID}\",
                        \"Weight\": ${v1_weight},
                        \"TTL\": 30,
                        \"ResourceRecords\": [{\"Value\": \"10.0.1.100\"}]
                    }
                },
                {
                    \"Action\": \"UPSERT\",
                    \"ResourceRecordSet\": {
                        \"Name\": \"${RECORD_NAME}\",
                        \"Type\": \"A\",
                        \"SetIdentifier\": \"${V2_SET_ID}\",
                        \"Weight\": ${v2_weight},
                        \"TTL\": 30,
                        \"ResourceRecords\": [{\"Value\": \"10.0.1.101\"}]
                    }
                }
            ]
        }"

    echo "Traffic shift applied. Waiting 60s for validation..."
    sleep 60

    # Check error rates
    ERROR_RATE=$(curl -s "http://prometheus:9090/api/v1/query?query=rate(http_requests_total{status=~'5..',version='v2'}[5m])" \
        | jq -r '.data.result[0].value[1] // "0"')

    echo "V2 error rate: ${ERROR_RATE} req/s"

    if (( $(echo "${ERROR_RATE} > 0.01" | bc -l) )); then
        echo "ERROR: V2 error rate too high, rolling back..."
        shift_traffic 100 0
        return 1
    fi
}

# Progressive canary deployment
echo "Starting canary deployment..."
shift_traffic 95 5
shift_traffic 80 20
shift_traffic 50 50
shift_traffic 20 80
shift_traffic 0 100
echo "Canary deployment complete: 100% on v2"
```

This complete GSLB implementation provides a robust foundation for multi-cluster traffic management. The combination of Route53 weighted routing, Cloudflare's anycast network, and custom health check propagation creates a system capable of sub-minute failover while maintaining geographic routing optimization for global user bases.
