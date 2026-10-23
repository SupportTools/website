---
title: "RKE2 Ingress-NGINX: Troubleshooting and 2026 Retirement"
date: 2025-01-22T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["RKE2", "Kubernetes", "Ingress", "ingress-nginx", "Traefik"]
categories:
- RKE2
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Fix RKE2 ingress-nginx 404, 502 and TLS errors, tune it with HelmChartConfig, and plan for its March 2026 retirement and RKE2's move to Traefik."
more_link: "yes"
url: "/rke2-ingress-nginx/"
quick_fix: |
  RKE2 runs ingress-nginx as the `rke2-ingress-nginx-controller` DaemonSet in `kube-system`, so start with
  `kubectl -n kube-system logs ds/rke2-ingress-nginx-controller --tail=100` and `kubectl describe ingress <name>`.
  Change its settings with a `HelmChartConfig` named `rke2-ingress-nginx` in `kube-system`, never by editing the DaemonSet.
  Upstream ingress-nginx was retired in March 2026 and RKE2 v1.36+ installs Traefik on new clusters, so plan a move to Traefik or Gateway API.
---

RKE2 ships the Ingress-NGINX controller as a packaged Helm chart, which makes it easy to run and easy to misconfigure. This guide covers where it lives on an RKE2 node, how to fix the common 404, 502 and TLS errors, a working `HelmChartConfig`, metrics and Grafana, and what the 2026 retirement of upstream ingress-nginx means for RKE2 clusters.

<!--more-->

# Ingress-NGINX for RKE2

## 2026 status: ingress-nginx is retired and RKE2 now defaults to Traefik

Read this first if you are building a new cluster or planning upgrades.

- **Upstream retirement.** The Kubernetes project [announced the retirement of ingress-nginx](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/) on November 11, 2025. Best-effort maintenance continued until March 2026, and after that there are no further releases, bug fixes or security patches from upstream. The [GitHub repository](https://github.com/kubernetes/ingress-nginx) was archived on March 24, 2026; its last listed release is controller v1.15.1 (chart 4.15.1). Existing deployments keep working, but the upstream project tells new users to pick a Gateway API implementation instead.
- **RKE2 default change.** Per the [RKE2 networking docs](https://docs.rke2.io/networking/networking_services), RKE2 v1.36 and later deploy **Traefik** by default on new clusters. Existing clusters are not switched automatically. On v1.36 ingress-nginx is still available but deprecated (set `ingress-controller: ingress-nginx` to keep it), and in v1.37 it is no longer available for new clusters.
- **Extended support.** SUSE states that Rancher Prime LTS customers get ingress-nginx support through December 2027 (see the [RKE2 ingress migration guide](https://docs.rke2.io/reference/ingress_migration)).

The `ingress-controller` option in `/etc/rancher/rke2/config.yaml` controls which controller RKE2 installs:

```yaml
# /etc/rancher/rke2/config.yaml
# One of: ingress-nginx, traefik, none. A list runs both during a migration.
ingress-controller:
  - ingress-nginx
  - traefik
```

During a migration, Traefik's ingress-nginx provider can serve your existing `Ingress` objects and understands many (not all) `nginx.ingress.kubernetes.io/*` annotations. The step-by-step, no-downtime procedure is in [Ingress-NGINX Retirement on RKE2: Migrating to Traefik Without Downtime](/ingress-nginx-retirement-rke2-migrating-traefik-without-downtime/). The rest of this page still applies to every cluster that runs ingress-nginx today.

---

## How Ingress-NGINX works on RKE2

### Architecture

RKE2 uses the Ingress-NGINX controller to expose services running inside the cluster. Key components:

1. **Ingress resource**: defines the host and path routing rules for HTTP and HTTPS traffic.
2. **Controller pods**: the `rke2-ingress-nginx-controller` DaemonSet in `kube-system`. By default it binds host ports 80 and 443 on each node it runs on.
3. **Load balancer integration**: an external or cloud load balancer usually sends traffic to those node ports. See [Running RKE2 Ingress-NGINX with an External LoadBalancer](/rke2-ingress-nginx-external-lb/) for that pattern.

The controller watches `Ingress` objects, renders `nginx.conf`, and reloads NGINX when the configuration changes.

Useful first commands:

```bash
kubectl -n kube-system get ds rke2-ingress-nginx-controller -o wide
kubectl -n kube-system get pods -l app.kubernetes.io/name=rke2-ingress-nginx -o wide
kubectl -n kube-system logs ds/rke2-ingress-nginx-controller --tail=100
kubectl get ingressclass
```

---

## Troubleshooting RKE2 Ingress-NGINX

### Common errors and their resolutions

#### **Backend service is offline (502 or 503)**
- **Cause**: the Service or pods behind the Ingress are not running, or the Service selector matches no pods.
- **Symptoms**:
  - Requests return 502 Bad Gateway or 503 Service Temporarily Unavailable.
  - Controller logs show upstream connection errors or "Service does not have any active Endpoint".
- **Resolution**:
  - Check the pods and Service: `kubectl get pods,svc -n <namespace>`.
  - Confirm the Service has endpoints: `kubectl get endpointslices -n <namespace> -l kubernetes.io/service-name=<service-name>`.
  - Check that the Service selector matches the pod labels with `kubectl describe svc <service-name> -n <namespace>`.

#### **HTTP requests going to an HTTPS port**
- **Cause**: the Ingress, Service or load balancer sends plain HTTP to a port that expects TLS (or the reverse).
- **Symptoms**:
  - Requests fail with SSL handshake errors or "400 The plain HTTP request was sent to HTTPS port".
- **Resolution**:
  - Check the `tls` section of the Ingress.
  - If the backend itself speaks HTTPS, add `nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"`.
  - Test both paths with `curl -v http://<host>` and `curl -vk https://<host>`.
  - Verify the external load balancer port mappings, for example 80 to node port 80 and 443 to node port 443.

#### **Misconfigured TLS certificates**
- **Cause**: the TLS secret is missing, in the wrong namespace, or does not cover the hostname.
- **Symptoms**:
  - Browsers show the "Kubernetes Ingress Controller Fake Certificate" or another untrusted certificate.
  - Logs show errors about a missing or invalid secret.
- **Resolution**:
  - Confirm the secret exists in the same namespace as the Ingress: `kubectl get secret <secret-name> -n <namespace>`.
  - Inspect the certificate: `kubectl get secret <secret-name> -n <namespace> -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -subject -ext subjectAltName -enddate`.
  - Make sure the Ingress host appears in the certificate's Subject Alternative Names.

#### **Requests falling back to the default backend (404)**
- **Cause**: no Ingress rule matches the requested host and path, or the Ingress uses an `ingressClassName` that this controller does not watch.
- **Symptoms**:
  - Requests return the controller's default "404 Not Found" page.
- **Resolution**:
  - Verify the `host` and `path` in the Ingress match the request, including the `pathType`.
  - Run `kubectl describe ingress <name> -n <namespace>` and check the class and the rules.
  - Check `kubectl get ingressclass`. On RKE2 the ingress-nginx class is `nginx`.
  - Test with an explicit Host header: `curl -v -H 'Host: example.com' http://<node-ip>/`.

Note: the `disable-catch-all` flag does not stop default backend fallback. It only makes the controller ignore "catch-all" Ingresses (Ingresses that define `spec.defaultBackend` with no rules), which is useful in multi-tenant clusters.

#### **Controller pods crash or will not start**
- **Cause**: an invalid ConfigMap value, a bad snippet, insufficient resources, or a port already in use on the node.
- **Symptoms**:
  - Controller pods restart repeatedly.
  - Logs show configuration test failures (`nginx: [emerg] ...`) or bind errors.
- **Resolution**:
  - Check logs, including the previous container: `kubectl -n kube-system logs <pod-name> --previous`.
  - Review the rendered settings: `kubectl -n kube-system get cm rke2-ingress-nginx-controller -o yaml`.
  - Check whether something else on the node holds ports 80, 443 or 10254 (`ss -ltnp`).
  - Raise resource requests and limits in the `HelmChartConfig` if pods are OOMKilled.

#### **Misconfigured Ingress (404, 503 or rejected objects)**
- **Cause**: a typo in annotations, paths or the backend Service, or an annotation the controller now refuses.
- **Symptoms**:
  - `kubectl apply` fails with an admission webhook error.
  - Requests return 404 or 503.
- **Resolution**:
  - Read the admission error, it usually names the bad field.
  - Snippet annotations (`configuration-snippet`, `server-snippet`) are disabled by default since controller v1.9, and since v1.12 the default `annotations-risk-level` of `High` rejects annotations rated Critical, which includes snippets. Enable them only if you trust everyone who can create Ingresses.
  - Make sure the validating webhook (`kubectl get validatingwebhookconfiguration`) is present so bad objects are caught at apply time.

---

## RKE2 HelmChartConfig

To customize the bundled controller, create a `HelmChartConfig`. RKE2 merges its `valuesContent` into the packaged chart. Put it in `/var/lib/rancher/rke2/server/manifests/rke2-ingress-nginx-config.yaml` on a server node, or apply it with `kubectl`.

### Example: `HelmChartConfig`

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-ingress-nginx
  namespace: kube-system
spec:
  valuesContent: |-
    controller:
      config:
        use-forwarded-headers: "true"
        enable-brotli: "true"
        # Only if you trust every user who can create Ingresses:
        # allow-snippet-annotations: "true"
        # annotations-risk-level: "Critical"
      extraArgs:
        publish-status-address: "203.0.113.10"
        default-ssl-certificate: "kube-system/wildcard-tls"
        enable-ssl-passthrough: "true"
        report-status-classes: "true"
      metrics:
        enabled: true
        service:
          annotations:
            prometheus.io/scrape: "true"
            prometheus.io/port: "10254"
        serviceMonitor:
          enabled: false
      enableTopologyAwareRouting: true
      podAnnotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "10254"
```

---

### Breakdown of the `HelmChartConfig`

#### **Metadata**
- **`name`**: must be `rke2-ingress-nginx` to target the bundled chart.
- **`namespace`**: must be `kube-system`, where RKE2 installs its packaged charts.

#### **`controller.config`** (the controller ConfigMap)
- **`use-forwarded-headers: "true"`**: trust incoming `X-Forwarded-*` headers. Use it only when an L7 proxy or load balancer sits in front of the nodes and sets those headers; otherwise clients can spoof their IP.
- **`enable-brotli: "true"`**: enable Brotli compression of responses.
- **`allow-snippet-annotations` and `annotations-risk-level`**: both are needed to use snippet annotations on current controllers. Leave them commented out unless you need snippets.

The old `enable-vts-status` key that appears in many older guides was removed from ingress-nginx years ago. Use the Prometheus metrics below instead.

#### **`controller.extraArgs`** (controller command-line flags)
- **`publish-status-address`**: the address written to `status.loadBalancer` of each Ingress, for example your external load balancer IP.
- **`default-ssl-certificate`**: the `namespace/name` of the secret used by the default HTTPS server and by Ingresses that have no `secretName`.
- **`enable-ssl-passthrough`**: allows `nginx.ingress.kubernetes.io/ssl-passthrough` so TLS is passed to the backend without termination.
- **`report-status-classes`**: reports status classes (2xx, 3xx, 4xx, 5xx) in metrics instead of individual codes, which cuts metric cardinality.

#### **`controller.metrics`**
- **`enabled: true`**: exposes Prometheus metrics on port 10254.
- **`serviceMonitor.enabled`**: set to `true` if you run the Prometheus Operator (for example Rancher Monitoring).

#### **`enableTopologyAwareRouting: true`**
- Adds the topology-aware routing annotation to the controller Service so kube-proxy prefers endpoints in the same zone as the client node. It only has an effect when your nodes carry zone labels.

---

## Example Ingress configurations

### Simple Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: simple-ingress
  namespace: default
spec:
  ingressClassName: nginx
  rules:
  - host: example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-service
            port:
              number: 80
```

- **`ingressClassName`**: binds the Ingress to the RKE2 ingress-nginx controller. Setting it explicitly matters once Traefik is also installed.
- **`host`** and **`path`**: the routing rule.
- **`service.name`** and **`service.port.number`**: the backend Service and port.

### Ingress with ingress-nginx annotations

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: advanced-ingress
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "30"
    # Requires allow-snippet-annotations and annotations-risk-level: Critical
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "X-Custom-Header: CustomValue";
spec:
  ingressClassName: nginx
  rules:
  - host: advanced.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: advanced-service
            port:
              number: 8080
  tls:
  - hosts:
    - advanced.example.com
    secretName: tls-secret
```

- **Annotations**:
  - `proxy-body-size`: maximum request body size.
  - `proxy-read-timeout` and `proxy-send-timeout`: backend timeouts in seconds (plain numbers, no unit).
  - `configuration-snippet`: raw NGINX directives for this location. Keep snippets small if you plan to migrate: Traefik's ingress-nginx provider only understands a short list of directives inside them (such as `more_set_headers`, `add_header`, `proxy_set_header`, `rewrite` and `return`).
- **TLS**: terminates HTTPS with the `tls-secret` secret for `advanced.example.com`.

---

## Adding the NGINX Grafana dashboard

### Step 1: Enable metrics

Make sure `controller.metrics.enabled: true` is set as in the `HelmChartConfig` above, then confirm the endpoint answers:

```bash
kubectl -n kube-system port-forward ds/rke2-ingress-nginx-controller 10254:10254 &
curl -s localhost:10254/metrics | grep -m5 nginx_ingress_controller_requests
```

### Step 2: Import the dashboard

1. In Grafana, go to **Dashboards > New > Import**.
2. Enter dashboard ID **9614** (NGINX Ingress controller) or upload the JSON from the [ingress-nginx repository](https://github.com/kubernetes/ingress-nginx/tree/main/deploy/grafana/dashboards).
3. Select your Prometheus data source and import.

### Step 3: Key metrics

- **Requests per second** by Ingress and status.
- **Latency** of requests and upstream responses.
- **Active connections** to the controller.
- **Error rate** of 4xx and 5xx responses.

### Example panel query

```promql
sum by (ingress, status) (rate(nginx_ingress_controller_requests[5m]))
```

The `namespace` and `ingress` labels on this metric describe the Ingress object that handled the request, not the controller, so filter on your application namespace rather than `kube-system`.

---

## FAQ

### Does upstream ingress-nginx still get security fixes?

No. Upstream maintenance ended in March 2026 and the repository is archived. RKE2 continues to package its own hardened build in current releases, and SUSE offers extended support for Rancher Prime LTS customers through December 2027, but plan a migration.

### Will upgrading RKE2 to v1.36 replace ingress-nginx with Traefik?

Not on an existing cluster. Upgraded clusters keep their current controller. New v1.36 clusters get Traefik unless you set `ingress-controller: ingress-nginx`.

### Should I move to Traefik or Gateway API?

On RKE2, Traefik is the supported path and can serve existing `Ingress` objects through its ingress-nginx provider while you migrate. For new applications, the upstream Kubernetes project recommends a Gateway API implementation, and Traefik supports Gateway API too.

### Why are my snippet annotations ignored or rejected?

Since v1.9 snippets are off by default (`allow-snippet-annotations: "false"`), and since v1.12 the default `annotations-risk-level: High` rejects Critical-risk annotations such as `configuration-snippet`. Both settings must be changed to use them.

---

## Related guides

- [Ingress-NGINX Retirement on RKE2: Migrating to Traefik Without Downtime](/ingress-nginx-retirement-rke2-migrating-traefik-without-downtime/)
- [Running RKE2 Ingress-NGINX with an External LoadBalancer](/rke2-ingress-nginx-external-lb/)
- [ingress-nginx CVE-2025-1974 Mitigation Guide](/ingress-nginx-cve-2025-1974-critical-vulnerability/)
- [Troubleshooting k8s Ingress: Ingress-Nginx and Traefik](/post/k8s-ingress-troubleshooting/)
