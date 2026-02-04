---
title: "Ingress-NGINX Retirement on RKE2: Migrating to Traefik Without Downtime"
date: 2026-02-04T00:00:00-05:00
draft: false
tags: ["RKE2", "Kubernetes", "Traefik", "Ingress-NGINX", "Migration", "Rancher", "Ingress Controller"]
categories:
- RKE2
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to migrating from ingress-nginx to Traefik on RKE2 clusters. Covers side-by-side operation, annotation conversion, RKE2-specific configuration, and zero-downtime migration strategies for production environments."
more_link: "yes"
url: "/ingress-nginx-retirement-rke2-migrating-traefik-without-downtime/"
---

The Kubernetes community announced in November 2025 that Ingress-NGINX is being retired. Maintenance halts completely in March 2026 — no more releases, no more bug fixes, no more security patches. If you're running RKE2, which ships ingress-nginx by default, this directly affects you.

This post walks through the practical side of migrating RKE2 clusters from ingress-nginx to Traefik. The emphasis is on running both controllers side-by-side so you can migrate gradually without taking production offline.

<!--more-->

## What the Retirement Means

The [official announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/) is clear about the timeline:

- **Now through March 2026**: Best-effort maintenance only (1-2 part-time maintainers)
- **March 2026**: All maintenance stops
- **After March 2026**: No security patches, no releases; repositories become read-only under `kubernetes-retired` for reference only

**Important clarification:** This retirement refers specifically to the **Kubernetes community ingress-nginx** project ([`kubernetes/ingress-nginx`](https://github.com/kubernetes/ingress-nginx)), not F5 NGINX Ingress Controller or other NGINX-branded controllers. If you are using a commercially supported NGINX-based controller from F5, check with your vendor for their support timeline.

Your existing ingress-nginx deployments will continue to function — nothing is being forcibly removed. But running an unmaintained ingress controller in production is a ticking clock. The ingress-nginx project has already had critical CVEs (like [CVE-2025-1974](https://support.tools/mitigating-cve-2025-1974-ingress-nginx-rke2/)), and those will stop getting patched.

The upstream recommendation is to migrate to the [Gateway API](https://gateway-api.sigs.k8s.io/) or to another actively maintained ingress controller. For RKE2 operators, Traefik is the most practical choice — it's a widely used open-source ingress controller maintained by Traefik Labs, it supports both Ingress resources and Gateway API, and it integrates well with the Rancher ecosystem.

> **SUSE/Rancher Extended Support:** SUSE has committed to [extended ingress-nginx support on RKE2](https://www.suse.com/c/trade-the-ingress-nginx-retirement-for-up-to-2-years-of-rke2-support-stability/) — up to 24 months on RKE2 v1.35 LTS (through December 2027). This gives you time to plan a careful migration rather than rushing. Start the migration now, but know that you have a supported runway if you're on an LTS release.

## Why Traefik for RKE2

Several ingress controllers could replace ingress-nginx, but Traefik has specific advantages for RKE2 environments:

1. **K3s already ships it** — If you run both K3s and RKE2, Traefik standardizes your ingress layer
2. **Gateway API support** — Traefik v3 has native Gateway API support, which is where the ecosystem is headed
3. **CRD-based configuration** — IngressRoute CRDs are more expressive than annotation-heavy Ingress resources
4. **Active maintenance** — Commercial backing from Traefik Labs with regular releases
5. **Built-in middleware** — Rate limiting, circuit breakers, and retry logic without external modules

That said, Traefik is not a drop-in replacement for NGINX. The configuration model, default behaviors, and observability tooling are all different. Plan for a learning curve.

## Assessing Your Current State

Before you start, document what you're working with. On an RKE2 cluster:

```bash
# Check your ingress-nginx deployment (upstream-style label)
kubectl get pods -n kube-system -l app.kubernetes.io/name=rke2-ingress-nginx

# If the above returns nothing, try the RKE2 instance label
kubectl get pods -n kube-system -l app.kubernetes.io/instance=rke2-ingress-nginx-controller

# Fallback: check for the DaemonSet directly
kubectl get daemonset -n kube-system | grep ingress-nginx
```

```
NAME                                      READY   STATUS    RESTARTS   AGE
rke2-ingress-nginx-controller-6k7wt       1/1     Running   0          14d
rke2-ingress-nginx-controller-8xj2p       1/1     Running   0          14d
rke2-ingress-nginx-controller-tmn4r       1/1     Running   0          14d
```

RKE2 deploys ingress-nginx as a DaemonSet by default. In the default configuration, the controller pods bind to ports 80 and 443 at the node level (the exact mechanism depends on your RKE2 version and any HelmChartConfig overrides). This is important — if ingress-nginx is binding host ports 80/443, Traefik cannot also bind to those same ports on the same nodes. However, Traefik behind a Service (LoadBalancer or NodePort) runs fine alongside ingress-nginx with no port conflict.

Inventory your Ingress resources:

```bash
# Count Ingress resources by namespace
kubectl get ingress --all-namespaces --no-headers | awk '{print $1}' | sort | uniq -c | sort -rn

# Check for NGINX-specific annotations
kubectl get ingress --all-namespaces -o json | \
  jq -r '.items[] | select(.metadata.annotations // {} | keys[] | startswith("nginx.ingress.kubernetes.io")) | "\(.metadata.namespace)/\(.metadata.name)"' | sort -u

# List unique NGINX annotations in use
kubectl get ingress --all-namespaces -o json | \
  jq -r '[.items[].metadata.annotations // {} | keys[] | select(startswith("nginx.ingress.kubernetes.io"))] | unique[]'
```

Save this output. You'll need it to understand the scope of annotation conversion later.

## Running Traefik Alongside Ingress-NGINX

The core strategy is: **deploy Traefik, test it, migrate Ingress resources one at a time, then remove ingress-nginx.** At no point should both controllers be fighting over the same traffic.

The conflict to avoid is specifically about **host-bound ports 80/443 on the same nodes**. If ingress-nginx is using host ports, Traefik cannot also bind those ports as a DaemonSet on the same nodes. But Traefik behind a Service (LoadBalancer or NodePort) runs fine alongside ingress-nginx with no conflict at all.

**Decision tree for your side-by-side setup:**

- **NodePort** → Fastest to set up; good for initial validation; not realistic for production traffic path since clients don't hit NodePorts directly
- **Separate LoadBalancer IP** → More realistic; requires MetalLB, kube-vip, or Cilium LB IPAM; recommended for pre-production validation

### Option 1: Traefik on Non-Standard Ports

The simplest approach. Deploy Traefik as a DaemonSet or Deployment using ports that don't conflict with ingress-nginx.

```yaml
# traefik-values.yaml
ports:
  web:
    port: 8080
    expose:
      default: true
    exposedPort: 8080
    nodePort: 30080
  websecure:
    port: 8443
    expose:
      default: true
    exposedPort: 8443
    nodePort: 30443

# Don't fight ingress-nginx for ingressClass
ingressClass:
  enabled: true
  isDefaultClass: false

# Use a Deployment initially, not a DaemonSet
deployment:
  kind: Deployment
  replicas: 2

service:
  type: NodePort

# Ensure Traefik only watches resources with its own ingressClass
providers:
  kubernetesIngress:
    ingressClass: traefik
  kubernetesCRD:
    ingressClass: traefik
```

Install Traefik:

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update

kubectl create namespace traefik

helm install traefik traefik/traefik \
  --namespace traefik \
  --values traefik-values.yaml \
  --version 34.3.0
```

Test by hitting Traefik directly:

```bash
# From a node or pod in the cluster
curl -H "Host: myapp.example.com" http://<node-ip>:30080
```

This approach is good for initial validation. The downside is that you're not testing the real traffic path — clients won't be hitting port 8080 in production.

### Option 2: Traefik with a Separate LoadBalancer IP

For a more realistic test, give Traefik its own dedicated IP address using MetalLB, kube-vip, or Cilium LB IPAM. This lets Traefik listen on standard ports (80/443) on a different IP than ingress-nginx.

#### With MetalLB

If you're already running MetalLB, create an IP pool for Traefik:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: traefik-pool
  namespace: metallb-system
spec:
  addresses:
    - 10.0.50.100-10.0.50.100
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: traefik-l2
  namespace: metallb-system
spec:
  ipAddressPools:
    - traefik-pool
```

Then configure Traefik to use a LoadBalancer Service:

```yaml
# traefik-values-metallb.yaml
ports:
  web:
    port: 8080
    expose:
      default: true
    exposedPort: 80
  websecure:
    port: 8443
    expose:
      default: true
    exposedPort: 443

ingressClass:
  enabled: true
  isDefaultClass: false

deployment:
  kind: Deployment
  replicas: 2

service:
  type: LoadBalancer
  annotations:
    metallb.universe.tf/address-pool: traefik-pool
```

#### With kube-vip

If your RKE2 cluster uses kube-vip for the control plane (common in bare-metal deployments), you can also use it for Services:

```yaml
# traefik-values-kubevip.yaml
service:
  type: LoadBalancer
  annotations:
    kube-vip.io/loadbalancerIPs: "10.0.50.101"
```

#### With Cilium LB IPAM or BGP

If you're running Cilium as your CNI (increasingly common on RKE2):

```yaml
apiVersion: "cilium.io/v2alpha1"
kind: CiliumLoadBalancerIPPool
metadata:
  name: traefik-pool
spec:
  blocks:
    - cidr: "10.0.50.0/28"
  serviceSelector:
    matchLabels:
      app.kubernetes.io/name: traefik
```

Traefik values:

```yaml
service:
  type: LoadBalancer
  labels:
    app.kubernetes.io/name: traefik
```

### Validating the Side-by-Side Setup

Once Traefik is running alongside ingress-nginx, verify isolation:

```bash
# Confirm ingress-nginx pods are running
kubectl get daemonset -n kube-system rke2-ingress-nginx-controller
kubectl get pods -n kube-system -l app.kubernetes.io/name=rke2-ingress-nginx -o wide

# Confirm Traefik pods are running
kubectl get pods -n traefik -l app.kubernetes.io/name=traefik -o wide

# Verify ingressClass resources
kubectl get ingressclass

# Test ingress-nginx is still serving traffic (use a node IP where the DaemonSet runs)
curl -s -o /dev/null -w "%{http_code}" -H "Host: existing-app.example.com" http://<node-ip>:80

# Test Traefik is reachable (NodePort example)
curl -s -o /dev/null -w "%{http_code}" -H "Host: test-app.example.com" http://<node-ip>:30080
# Or if using LoadBalancer:
curl -s -o /dev/null -w "%{http_code}" -H "Host: test-app.example.com" http://<traefik-lb-ip>:80
```

Expected output:

```
NAME      CONTROLLER                      PARAMETERS   AGE
nginx     k8s.io/ingress-nginx            <none>       180d
traefik   traefik.io/ingress-controller   <none>       5m
```

At this point, ingress-nginx owns all existing Ingress resources (because they either specify `ingressClassName: nginx` or have no class and nginx is the default). Traefik is idle, waiting for work.

## Migration Strategies

### Strategy 1: Ingress-by-Ingress Migration (Recommended)

Migrate one Ingress resource at a time by changing its `ingressClassName`. This is the lowest-risk approach.

**Step 1:** Pick a low-risk workload to start with — an internal tool, a staging service, something where a few minutes of downtime won't page anyone.

**Step 2:** Convert NGINX-specific annotations to Traefik equivalents (see the conversion table below).

**Step 3:** Update the `ingressClassName`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: internal-dashboard
  namespace: monitoring
  annotations:
    # Remove NGINX annotations
    # nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    # Add Traefik annotations if needed (or use IngressRoute CRDs)
spec:
  ingressClassName: traefik  # Changed from "nginx"
  rules:
    - host: dashboard.internal.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: grafana
                port:
                  number: 3000
```

**Step 4:** Update DNS. If ingress-nginx and Traefik have different IPs, point the hostname at Traefik's IP. If you're using an external load balancer, update the backend pool.

> **Traffic Steering Options:**
> - **LB backend cutover:** Shift external load balancer backends or weights from ingress-nginx to Traefik. This gives you true zero-downtime cutover with instant rollback by shifting weights back.
> - **DNS cutover:** Lower your DNS TTL well in advance (e.g., to 60s, at least 24 hours before), run both controllers in parallel, then update the DNS record. Drain the old controller after the TTL expires. Rollback means flipping the record back — but be aware of client-side DNS caching.

**Step 5:** Verify traffic is flowing through Traefik:

```bash
# Check Traefik's access logs
kubectl logs -n traefik -l app.kubernetes.io/name=traefik --tail=50

# Or use the Traefik dashboard (if enabled) — port-forward to a pod's API port
kubectl port-forward -n traefik deployment/traefik 9000:9000
# Then open http://localhost:9000/dashboard/ in your browser
# WARNING: Never expose the Traefik dashboard publicly. Use port-forward for debugging only.
```

**Step 6:** Repeat for each Ingress resource, increasing criticality as you gain confidence.

### Strategy 2: Namespace-at-a-Time Migration

If you have many Ingress resources, migrating one at a time can be tedious. Instead, migrate entire namespaces:

```bash
# List all Ingress resources in a namespace
kubectl get ingress -n my-app -o name

# Patch all of them to use Traefik
for ing in $(kubectl get ingress -n my-app -o name); do
  kubectl patch $ing -n my-app --type=merge \
    -p '{"spec":{"ingressClassName":"traefik"}}'
done
```

This is faster but riskier — if something is wrong with the Traefik configuration for that namespace, everything in it breaks at once.

### Rollback

Rolling back is straightforward — change `ingressClassName` back to `nginx`:

```bash
kubectl patch ingress internal-dashboard -n monitoring --type=merge \
  -p '{"spec":{"ingressClassName":"nginx"}}'
```

If you also changed DNS, point it back at the ingress-nginx IP. Because both controllers are running simultaneously, rollback is immediate at the Kubernetes/controller layer. However, user-perceived rollback speed depends on DNS TTL expiration, load balancer health check intervals, and client-side caching behavior.

## Converting NGINX Configuration to Traefik

### Common Annotation Mappings

**These mappings are conceptual starting points. Not all NGINX settings have 1:1 Traefik equivalents — test every conversion in a non-production environment before migrating.**

| NGINX Annotation | Traefik Equivalent | Notes |
|---|---|---|
| `nginx.ingress.kubernetes.io/proxy-body-size` | Traefik middleware: `buffering` | Use IngressRoute + Middleware CRD. Note: buffering middleware stores the full request/response in memory — verify behavior for large upload workloads |
| `nginx.ingress.kubernetes.io/proxy-read-timeout` | Client timeouts: `entryPoints.*.transport.respondingTimeouts`; upstream timeouts: `ServersTransport` CRD | Client-facing and upstream timeouts are configured at different layers in Traefik |
| `nginx.ingress.kubernetes.io/proxy-send-timeout` | Same as above | |
| `nginx.ingress.kubernetes.io/ssl-redirect` | Entrypoint-level HTTP→HTTPS redirection (static config) or `redirectScheme` middleware (dynamic) | Configure `web.redirectTo.entryPoint: websecure` in Helm values for global redirect, or use a `redirectScheme` middleware per-route |
| `nginx.ingress.kubernetes.io/force-ssl-redirect` | Traefik `redirectScheme` middleware | |
| `nginx.ingress.kubernetes.io/rewrite-target` | Traefik `replacePathRegex` or `stripPrefix` middleware | Behavior differs — test carefully |
| `nginx.ingress.kubernetes.io/auth-type` + `auth-secret` | Traefik `basicAuth` middleware | |
| `nginx.ingress.kubernetes.io/cors-*` | Traefik `headers` middleware with CORS settings | |
| `nginx.ingress.kubernetes.io/whitelist-source-range` | Traefik `ipAllowList` middleware | |
| `nginx.ingress.kubernetes.io/proxy-buffer-size` | Traefik `buffering` middleware | |
| `nginx.ingress.kubernetes.io/configuration-snippet` | **No direct equivalent** | See below |
| `nginx.ingress.kubernetes.io/server-snippet` | **No direct equivalent** | See below |

### What Doesn't Translate Directly

**Snippets**: NGINX's `configuration-snippet` and `server-snippet` annotations let you inject raw NGINX configuration. Traefik has no equivalent — it doesn't use a config-file-based architecture. Any raw NGINX directives need to be reimplemented using Traefik middlewares or plugins.

Common snippet patterns and their Traefik solutions:

```nginx
# NGINX snippet: Custom headers
more_set_headers "X-Frame-Options: SAMEORIGIN";
```

Traefik equivalent (Middleware CRD):

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: security-headers
  namespace: my-app
spec:
  headers:
    customFrameOptionsValue: "SAMEORIGIN"
    contentTypeNosniff: true
    browserXssFilter: true
```

```nginx
# NGINX snippet: Custom error pages
error_page 503 /maintenance.html;
```

Traefik equivalent: Use the `errors` middleware:

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: custom-errors
  namespace: my-app
spec:
  errors:
    status:
      - "500-599"
    query: /{status}.html
    service:
      name: error-pages
      port: 80
```

```nginx
# NGINX snippet: Rate limiting by IP
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req zone=api burst=20 nodelay;
```

Traefik equivalent:

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: rate-limit
  namespace: my-app
spec:
  rateLimit:
    average: 10
    burst: 20
```

### Rewrite Behavior Differences

This is the biggest gotcha. NGINX's `rewrite-target` uses capture groups from the path regex:

```yaml
# NGINX rewrite pattern
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /api(/|$)(.*)
            pathType: ImplementationSpecific
```

Traefik handles this differently with `stripPrefix` or `replacePathRegex`:

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: strip-api-prefix
  namespace: my-app
spec:
  stripPrefix:
    prefixes:
      - /api

# Or for more complex rewrites:
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: rewrite-api
  namespace: my-app
spec:
  replacePathRegex:
    regex: "^/api/(.*)"
    replacement: "/$1"
```

Test every rewrite rule. The regex behavior and path matching semantics are subtly different between the two controllers.

### ConfigMap Settings vs Traefik Static/Dynamic Config

NGINX uses a ConfigMap for global settings:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rke2-ingress-nginx-controller
  namespace: kube-system
data:
  proxy-body-size: "100m"
  proxy-read-timeout: "300"
  proxy-send-timeout: "300"
  use-forwarded-headers: "true"
  compute-full-forwarded-for: "true"
```

Traefik splits configuration into two layers:

- **Static configuration**: Set via Helm values or CLI arguments (entrypoints, providers, global settings)
- **Dynamic configuration**: Set via CRDs (IngressRoute, Middleware, etc.)

The ConfigMap equivalent in Traefik is mostly Helm values:

```yaml
# traefik-values.yaml
additionalArguments:
  - "--entryPoints.web.forwardedHeaders.trustedIPs=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  - "--entryPoints.websecure.forwardedHeaders.trustedIPs=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  - "--serversTransport.maxIdleConnsPerHost=250"

# For global timeouts, configure at the entrypoint level
ports:
  web:
    transport:
      respondingTimeouts:
        readTimeout: 300s
        writeTimeout: 300s
        idleTimeout: 180s
  websecure:
    transport:
      respondingTimeouts:
        readTimeout: 300s
        writeTimeout: 300s
        idleTimeout: 180s
```

## What's Different with Traefik

### Architecture

NGINX is a reverse proxy configured through a generated `nginx.conf` that gets reloaded on changes. Traefik is a Go-native reverse proxy that watches Kubernetes resources directly and reconfigures in-memory without reloads.

This means:
- **No config reloads** — Traefik picks up changes within seconds without dropping connections
- **No Lua** — NGINX uses Lua for dynamic behavior; Traefik uses middleware chains
- **Different performance profile** — Performance characteristics differ between the two controllers; benchmark your own workload rather than relying on generic comparisons. Traefik's in-memory reconfiguration avoids reload-related connection drops

### CRDs vs Annotations

Traefik supports standard Kubernetes Ingress resources, but its native configuration model uses CRDs:

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: my-app
  namespace: my-app
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`app.example.com`) && PathPrefix(`/api`)
      kind: Rule
      middlewares:
        - name: rate-limit
        - name: security-headers
      services:
        - name: my-app
          port: 8080
  tls:
    certResolver: letsencrypt
```

IngressRoute CRDs are more expressive than Ingress resources. You don't need annotations for routing logic — it's all in the spec. For a migration, you can start with standard Ingress resources (just changing `ingressClassName`) and convert to IngressRoute CRDs later.

### Observability

Traefik has a built-in dashboard and exposes Prometheus metrics natively:

```yaml
# traefik-values.yaml
metrics:
  prometheus:
    entryPoint: metrics
    addEntryPointsLabels: true
    addRoutersLabels: true
    addServicesLabels: true

# Enable the dashboard
ingressRoute:
  dashboard:
    enabled: true
    matchRule: Host(`traefik.internal.example.com`)
    entryPoints:
      - websecure
```

> **Security warning:** Do not expose the Traefik dashboard publicly. Protect it with authentication middleware and IP allowlisting, or restrict access to internal-only DNS. The dashboard exposes detailed routing information that could aid attackers.

Note that the metrics entrypoint port must be exposed on the Traefik Service for ServiceMonitor to scrape it. Verify with:

```bash
kubectl get svc traefik -n traefik -o jsonpath='{.spec.ports}' | jq .
```

If you don't see a `metrics` port in the output, add it to your Helm values under `ports.metrics.expose.default: true`.

The metrics are different from ingress-nginx's metrics. If you have Grafana dashboards built around `nginx_ingress_controller_*` metrics, you'll need to rebuild them using `traefik_*` metrics. The [official Traefik Grafana dashboard](https://grafana.com/grafana/dashboards/17346-traefik-official-standalone-dashboard/) is a good starting point.

### TLS and Certificate Handling

NGINX relies on cert-manager to create and manage TLS certificates stored in Kubernetes Secrets. Traefik can work the same way, but it also has a built-in ACME resolver:

```yaml
# traefik-values.yaml
certResolvers:
  letsencrypt:
    email: certs@example.com
    tlsChallenge: true
    storage: /data/acme.json

persistence:
  enabled: true
  size: 128Mi
```

If you're already using cert-manager, keep using it. Traefik's built-in ACME works fine for simpler setups but cert-manager gives you more control over certificate lifecycle, especially with DNS challenges across multiple clusters.

## RKE2-Specific Configuration

### Disabling the Default Ingress-NGINX

RKE2 deploys ingress-nginx via a HelmChart. The primary documented knob to disable it is the `ingress-controller` config option:

```yaml
# /etc/rancher/rke2/config.yaml (on each server node)
# Option 1 (preferred): Set the ingress controller to "none" or "traefik"
ingress-controller: none

# Option 2 (alternative): Explicitly disable the rke2-ingress-nginx chart
# disable:
#   - rke2-ingress-nginx
```

Then restart the RKE2 service:

```bash
systemctl restart rke2-server.service
```

**Do not do this until Traefik is fully operational and all Ingress resources have been migrated.** The change takes effect after RKE2 picks up the config change (typically on restart). Verify that the controller resources are actually removed:

```bash
kubectl get daemonset -n kube-system | grep ingress-nginx
kubectl get pods -n kube-system -l app.kubernetes.io/name=rke2-ingress-nginx
```

For Rancher-managed clusters, you can set this through the cluster configuration in the Rancher UI under **Cluster Management > Edit YAML**, or via the Rancher API:

```yaml
spec:
  rkeConfig:
    machineGlobalConfig:
      disable:
        - rke2-ingress-nginx
```

### Installing Traefik on Rancher-Managed Clusters

For clusters managed through Rancher, you have several installation options:

**Option A: Helm via Rancher Apps (Cluster Explorer)**

Navigate to **Apps > Charts** in the Rancher UI, search for Traefik, and install from the partner charts. This gives Rancher visibility into the deployment.

**Option B: Helm CLI**

If you prefer CLI management:

```bash
helm install traefik traefik/traefik \
  --namespace traefik \
  --create-namespace \
  --values traefik-values.yaml
```

**Option C: Fleet (GitOps)**

For multi-cluster deployments managed by Fleet:

```yaml
# fleet.yaml
defaultNamespace: traefik
helm:
  repo: https://traefik.github.io/charts
  chart: traefik
  version: "34.3.0"
  releaseName: traefik
  valuesFiles:
    - values.yaml
targetCustomizations:
  - name: production
    clusterSelector:
      matchLabels:
        environment: production
    helm:
      valuesFiles:
        - values-production.yaml
```

### Common Pitfalls in RKE2 Environments

**1. Port conflicts with ingress-nginx DaemonSet**

If ingress-nginx is running as a DaemonSet binding host ports 80 and 443 on every node (common in default RKE2 configurations), you cannot run Traefik as a DaemonSet on the same ports until ingress-nginx is removed. Use a LoadBalancer Service or non-standard ports during the transition. Verify your current port binding:

```bash
kubectl get daemonset -n kube-system rke2-ingress-nginx-controller -o jsonpath='{.spec.template.spec.hostNetwork}'
```

**2. HelmChartConfig conflicts**

RKE2 deploys packaged components as HelmCharts. HelmChartConfig is the supported override mechanism for customizing these charts (e.g., changing ingress-nginx settings while it's still active). However, for disabling the ingress controller entirely, use the `disable` or `ingress-controller` config knobs in `/etc/rancher/rke2/config.yaml` rather than deleting the HelmChartConfig resource — RKE2 will reconcile it back.

**3. Ingress resources without an explicit ingressClassName**

> **Migration prerequisite:** Before migration, make `spec.ingressClassName` explicit on every Ingress resource. Some RKE2 configurations don't watch ingresses without a class set (`--watch-ingress-without-class=false`), so implicit defaults may not behave as expected. Audit with:
> ```bash
> kubectl get ingress --all-namespaces -o json | \
>   jq -r '.items[] | select(.spec.ingressClassName == null) | "\(.metadata.namespace)/\(.metadata.name)"'
> ```

Older Ingress resources may not have `ingressClassName` set. When you install Traefik, make sure it is **not** set as the default IngressClass, or it will try to serve those resources too:

```yaml
# traefik-values.yaml
ingressClass:
  enabled: true
  isDefaultClass: false  # Critical during migration
```

Only set `isDefaultClass: true` after all Ingress resources have been explicitly assigned to either `nginx` or `traefik`.

**4. NetworkPolicy interference**

If you have NetworkPolicies that allow traffic to `kube-system` for ingress-nginx, you'll need equivalent policies for the `traefik` namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-traefik-ingress
  namespace: my-app
spec:
  podSelector: {}
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: traefik
```

**5. Service Monitor and PrometheusRule resources**

If you're using the Prometheus Operator for monitoring, create a ServiceMonitor for Traefik:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: traefik
  namespace: traefik
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: traefik
  endpoints:
    - port: metrics
      interval: 15s
```

## Migration Checklist

### Pre-Migration Prerequisites

- [ ] Ensure every Ingress resource has explicit `spec.ingressClassName` set
- [ ] Lower DNS TTL ahead of cutover if using DNS-based traffic steering
- [ ] Confirm TLS certificate parity on Traefik before shifting any traffic
- [ ] Decide on traffic steering method (LB backend shift vs DNS cutover)

### Full Migration Checklist

- [ ] Inventory all Ingress resources and NGINX-specific annotations
- [ ] Deploy Traefik alongside ingress-nginx (non-standard ports or separate IP)
- [ ] Configure Traefik provider-level class filtering (`providers.kubernetesIngress.ingressClass: traefik`)
- [ ] Create Traefik Middleware CRDs for any NGINX snippets or annotations in use
- [ ] Set `ingressClass.isDefaultClass: false` on Traefik
- [ ] Migrate a low-risk Ingress resource to Traefik, verify traffic
- [ ] Update monitoring (Grafana dashboards, alerts) for Traefik metrics
- [ ] Migrate remaining Ingress resources, starting with least critical
- [ ] Convert high-value Ingress resources to IngressRoute CRDs (optional, recommended)
- [ ] Update DNS and external load balancer configuration
- [ ] Verify all traffic is flowing through Traefik
- [ ] Disable `rke2-ingress-nginx` in RKE2 config
- [ ] Restart RKE2 server nodes to remove ingress-nginx
- [ ] Set Traefik as the default IngressClass
- [ ] Remove leftover NGINX annotations from migrated Ingress resources
- [ ] Update runbooks and documentation

## Related Resources

- [SUSE: Trade the Ingress-NGINX Retirement for Up to 2 Years of RKE2 Support Stability](https://www.suse.com/c/trade-the-ingress-nginx-retirement-for-up-to-2-years-of-rke2-support-stability/) — SUSE's extended support commitment for ingress-nginx on RKE2 LTS
- [How to Deploy NeuVector in an RKE2 Cluster with Traefik](https://support.scc.suse.com/s/kb/How-to-deploy-NeuVector-in-a-RKE2-cluster-with-Traefik?language=en_US) — SUSE KB for NeuVector + RKE2 + Traefik integration
- [Official Ingress-NGINX Retirement Announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/) — The Kubernetes project blog post announcing the retirement
- [Gateway API Migration Guide](https://gateway-api.sigs.k8s.io/guides/migrating-from-ingress/) — For teams considering Gateway API as an alternative or future direction

## Summary

The ingress-nginx retirement is real and the timeline is tight. For RKE2 operators, the migration path to Traefik is well-defined but not trivial — especially if you rely heavily on NGINX-specific annotations or snippet-based configuration.

The key is to run both controllers side-by-side. This eliminates the "big bang" risk and lets you validate Traefik's behavior for each workload before committing. Start with your least critical services, build confidence, and work your way up to production-critical workloads.

Don't wait until March 2026. Start the migration now while you still have ingress-nginx maintainers available to patch issues.
