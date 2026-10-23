---
title: "ModSecurity on Ingress-NGINX: Enable the WAF and OWASP CRS"
date: 2024-10-16T01:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["ModSecurity", "Ingress-NGINX", "Kubernetes", "OWASP CRS", "WAF"]
categories:
- Kubernetes
- Ingress
author: "Matthew Mattox - mmattox@support.tools"
description: "Enable ModSecurity and the OWASP CRS in ingress-nginx, switch DetectionOnly to blocking, fix rejected snippets, and plan a WAF after the 2026 retirement."
more_link: "yes"
url: "/modsecurity-kubernetes-ingress-nginx/"
quick_fix: |
  In the ingress-nginx ConfigMap (Helm: `controller.config`) set `enable-modsecurity: "true"` and `enable-owasp-modsecurity-crs: "true"`.
  That loads the OWASP CRS in DetectionOnly mode. To block, add `modsecurity-snippet` with `SecRuleEngine On` in the same ConfigMap.
  The per-Ingress `nginx.ingress.kubernetes.io/modsecurity-snippet` annotation is rejected by default (Critical risk), so keep rules in the ConfigMap.
  Upstream ingress-nginx was retired in March 2026, and Traefik's ingress-nginx compatibility does not support ModSecurity, so plan a WAF replacement.
---

The Kubernetes Ingress-NGINX controller ships with **ModSecurity** (libmodsecurity v3) and the **OWASP Core Rule Set (CRS)**, which turns the controller into a Web Application Firewall (WAF). This guide shows how to enable it cluster-wide or per Ingress, how to move from detection to blocking, how to test and read the logs, and what the 2025 to 2026 changes to ModSecurity and ingress-nginx mean for you.

<!--more-->

## 2026 status: ModSecurity, the CRS and ingress-nginx

Three things changed since this guide was first written:

- **ingress-nginx is retired.** The Kubernetes project [announced the retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/) in November 2025. Best-effort maintenance ended in March 2026 and the repository was archived on March 24, 2026, so there are no more upstream releases or security fixes. Existing installs keep running.
- **ModSecurity moved to OWASP.** Trustwave, the original sponsor, [transferred ModSecurity to OWASP](https://owasp.org/blog/2024/01/09/ModSecurity) starting in January 2024 and ended its own support on July 1, 2024. The engine is still maintained as an OWASP project.
- **The OWASP CRS is active.** CRS 4.x is the current major line (v4.30.0 was the newest release at the time of this update). The build script on the final ingress-nginx main branch pins libmodsecurity v3.0.14 and CRS v4.22.0, so the rules inside your controller image are frozen at whatever your image shipped with.

What this means in practice:

- If you stay on ingress-nginx for now, ModSecurity keeps working, but you will not get new CRS rules or engine fixes through upstream images. Vendor builds (for example the hardened images RKE2 ships, or SUSE's extended support for Rancher Prime) may continue to patch it; check your vendor.
- **Traefik's ingress-nginx provider does not support `enable-modsecurity`** ([Traefik docs](https://doc.traefik.io/traefik/reference/routing-configuration/kubernetes/ingress-nginx/)). If you migrate to Traefik, as new RKE2 v1.36+ clusters do by default, your WAF does not come along automatically.
- The usual replacement is **OWASP Coraza**, a Go WAF engine that runs CRS rules. It is available as a [Traefik Wasm plugin](https://github.com/jcchavezs/coraza-http-wasm-traefik) and as [coraza-spoa](https://github.com/corazawaf/coraza-spoa) for HAProxy (still marked experimental). A WAF at the edge (cloud WAF or CDN) is the other common option.

## What ModSecurity does in ingress-nginx

There are three ways to use it:

1. **Default configuration (DetectionOnly).** With only `enable-modsecurity` set, ModSecurity runs the recommended configuration in DetectionOnly mode. It logs, it does not block.
2. **OWASP Core Rule Set.** Generic attack detection for SQL injection, XSS, local and remote file inclusion, remote code execution, scanner detection, session fixation and data leakage.
3. **Custom rules (snippet).** Your own `SecRule` directives and CRS tuning, either in the ConfigMap or per Ingress.

Start in DetectionOnly, watch the logs for false positives, tune, then switch to blocking.

## Option 1: Enable ModSecurity and the CRS for the whole controller

With the upstream Helm chart, set this in your values:

```yaml
controller:
  config:
    enable-modsecurity: "true"
    enable-owasp-modsecurity-crs: "true"
    # Switch from DetectionOnly to blocking, and log JSON audit records to stdout
    modsecurity-snippet: |
      SecRuleEngine On
      SecRequestBodyAccess On
      SecAuditEngine RelevantOnly
      SecAuditLogParts ABIJDEFHZ
      SecAuditLogFormat JSON
      SecAuditLogType Serial
      SecAuditLog /dev/stdout
```

On RKE2, put the same `controller.config` block in a `HelmChartConfig` named `rke2-ingress-nginx` in `kube-system` (see [RKE2 Ingress-NGINX](/rke2-ingress-nginx/) for the full example).

The ConfigMap-level `modsecurity-snippet` is set by cluster admins, so it is not subject to the annotation risk checks described below. This is the safest place for WAF rules.

Note that enabling ModSecurity in the ConfigMap turns it on for **every** Ingress served by the controller. Disable it for a specific Ingress with `nginx.ingress.kubernetes.io/enable-modsecurity: "false"`.

## Option 2: Enable ModSecurity per Ingress

If you do not want a cluster-wide WAF, leave `enable-modsecurity` off in the ConfigMap and use annotations:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/enable-modsecurity: "true"
    nginx.ingress.kubernetes.io/enable-owasp-core-rules: "true"
    nginx.ingress.kubernetes.io/modsecurity-transaction-id: "$request_id"
```

`enable-modsecurity` and `enable-owasp-core-rules` are rated Low risk and work with default settings. `modsecurity-transaction-id` is rated High, which the default `annotations-risk-level: High` still accepts.

### Why the modsecurity-snippet annotation is rejected

`nginx.ingress.kubernetes.io/modsecurity-snippet` is rated **Critical** in the [annotation risk table](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations-risk/). Since controller v1.12 the default `annotations-risk-level` is `High`, so the admission webhook rejects Critical annotations, and snippet annotations are also gated by `allow-snippet-annotations`, which defaults to `false` since v1.9. To use it you must set both in the ConfigMap:

```yaml
controller:
  config:
    allow-snippet-annotations: "true"
    annotations-risk-level: "Critical"
```

Only do that if you trust everyone who can create Ingress objects, because snippets can inject arbitrary NGINX configuration (this is the class of problem behind [CVE-2025-1974](/ingress-nginx-cve-2025-1974-critical-vulnerability/)).

If you use both `enable-owasp-core-rules` and `modsecurity-snippet` on the same Ingress, only the snippet takes effect. Include the CRS yourself:

```
Include /etc/nginx/owasp-modsecurity-crs/nginx-modsecurity.conf
```

## Deploy a test application

```bash
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: meow
spec:
  replicas: 2
  selector:
    matchLabels:
      app: meow
  template:
    metadata:
      labels:
        app: meow
    spec:
      containers:
      - name: meow
        image: registry.k8s.io/e2e-test-images/agnhost:2.39
        args: ["netexec", "--http-port=8080"]
        ports:
        - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: meow-svc
spec:
  selector:
    app: meow
  ports:
  - port: 80
    targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: meow-ingress
  annotations:
    nginx.ingress.kubernetes.io/enable-modsecurity: "true"
    nginx.ingress.kubernetes.io/enable-owasp-core-rules: "true"
spec:
  ingressClassName: nginx
  rules:
  - host: meow.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: meow-svc
            port:
              number: 80
EOF
```

The old `gcr.io/kubernetes-e2e-test-images/echoserver` image used in many older guides is no longer available; `agnhost netexec` from `registry.k8s.io` is a maintained replacement.

## Test the WAF

Find an address for the controller (a LoadBalancer IP, or a node IP where the controller binds ports 80 and 443) and send requests with the right Host header:

```bash
IP=<ingress-ip>

# Normal request: expect 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: meow.example.com' "http://$IP/"

# Path traversal attempt: expect 403 once SecRuleEngine is On
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: meow.example.com' "http://$IP/?file=../../../../etc/passwd"
```

In DetectionOnly mode both requests return 200, and the second one appears in the audit log. After you set `SecRuleEngine On`, the second request returns **403 Forbidden** because the CRS anomaly score passes the blocking threshold.

## Read the logs

With `SecAuditLog /dev/stdout`, audit records are in the controller logs:

```bash
# Upstream chart
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller | grep -i modsecurity

# RKE2
kubectl -n kube-system logs ds/rke2-ingress-nginx-controller | grep -i modsecurity
```

If you kept the default file-based audit log, it is written under `/var/log/audit/` inside the controller container. List and read it with `kubectl exec`, for example `kubectl -n ingress-nginx exec deploy/ingress-nginx-controller -- ls -R /var/log/audit/`, or use the path you set in `SecAuditLog`.

Check that the configuration was rendered:

```bash
kubectl -n ingress-nginx exec deploy/ingress-nginx-controller -- grep -n -i modsecurity /etc/nginx/nginx.conf | head
```

## Tuning false positives

- Raise the CRS paranoia level only after a quiet period at level 1.
- Remove a rule for one application instead of disabling the WAF: `SecRuleRemoveById 942100` in the snippet for that Ingress (or by URI in the ConfigMap with a `SecRule REQUEST_URI` plus `ctl:ruleRemoveById` action).
- Keep `SecRequestBodyAccess On` only where you need body inspection; very large uploads add latency.

## FAQ

### Is ModSecurity dead?

No. Trustwave ended its support on July 1, 2024, but the project moved to OWASP and is still maintained. What ended is commercial support from Trustwave, and NGINX Inc's own ModSecurity WAF module for NGINX Plus.

### Does ingress-nginx still get new CRS rules?

Not from upstream. The project is archived, so the CRS version in your image does not change unless your vendor rebuilds it. Plan a move to a maintained WAF.

### Does Traefik support ModSecurity annotations?

No. Traefik's ingress-nginx provider lists `enable-modsecurity` as unsupported. Use the Coraza plugin (which runs CRS rules) or a WAF in front of the cluster.

### Why does my Ingress fail with "annotation ... is forbidden" or a risk level error?

You are using a Critical annotation such as `modsecurity-snippet` while `annotations-risk-level` is `High` (the default since v1.12). Move the rules to the ConfigMap, or raise the risk level if you accept the risk.

## Related guides

- [RKE2 Ingress-NGINX: Troubleshooting and 2026 Retirement](/rke2-ingress-nginx/)
- [ingress-nginx CVE-2025-1974 Mitigation Guide](/ingress-nginx-cve-2025-1974-critical-vulnerability/)
- [Ingress-NGINX Retirement on RKE2: Migrating to Traefik Without Downtime](/ingress-nginx-retirement-rke2-migrating-traefik-without-downtime/)
