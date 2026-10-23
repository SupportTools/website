---
title: "Set Up NGINX Ingress on GKE with NEGs (and What's Next)"
date: 2025-02-13T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["GKE", "Ingress", "Load Balancer", "Google Cloud", "Kubernetes", "Gateway API"]
categories:
- GKE
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Run ingress-nginx on GKE behind a Google Cloud Application Load Balancer with standalone NEGs, then plan a move to GKE Gateway API after its retirement."
more_link: "yes"
url: "/setup-nginx-ingress-gke/"
quick_fix: |
  Install ingress-nginx with `controller.service.type: ClusterIP` and the annotation `cloud.google.com/neg: '{"exposed_ports": {"80":{"name": "ingress-nginx-80-neg-http"}}}'`,
  then attach that NEG to a global backend service with `--load-balancing-scheme=EXTERNAL_MANAGED`, a health check on `/healthz`, and a firewall rule for `130.211.0.0/22` and `35.191.0.0/16`.
  ingress-nginx was retired upstream in March 2026, so for new GKE work use GKE Gateway API (`gatewayClassName: gke-l7-global-external-managed`) instead.
---

This guide puts the community ingress-nginx controller behind a Google Cloud Application Load Balancer on GKE using standalone Network Endpoint Groups (NEGs), adds a test application, and shows the internal variant. Because ingress-nginx is now retired, it ends with the GKE Gateway API path that Google documents as the replacement.

<!--more-->

## Before you start: ingress-nginx retirement

The Kubernetes project [retired ingress-nginx](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/): best-effort maintenance ended in March 2026, and there are no further releases or security fixes. Existing installs keep working. On GKE, Google's [Migrate Ingress to Gateway API](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/migrate-ingress-gateway) guide covers moving an ingress-nginx Ingress to a GKE Gateway with the `ingress2gateway` tool. If you are starting fresh, skip to [the Gateway API section](#alternative-gke-gateway-api). If you already run ingress-nginx on GKE, the steps below are still the right way to put it behind a Google load balancer.

## Step 1: Install the ingress-nginx controller with a standalone NEG

Expose the controller as a `ClusterIP` Service and ask GKE to create a named NEG for port 80:

```yaml
# values.yaml
controller:
  service:
    type: ClusterIP
    annotations:
      cloud.google.com/neg: '{"exposed_ports": {"80":{"name": "ingress-nginx-80-neg-http"}}}'
```

Install it:

```bash
helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  -f values.yaml
```

The chart repository still serves the final releases (chart 4.15.x) even though the project is archived.

Check that the NEG exists. GKE creates one NEG per zone that has controller pods:

```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.metadata.annotations.cloud\.google\.com/neg-status}{"\n"}'
gcloud compute network-endpoint-groups list --filter="name=ingress-nginx-80-neg-http"
```

## Step 2: Create the external Application Load Balancer

These commands build a global external Application Load Balancer (`EXTERNAL_MANAGED`). Older guides use `EXTERNAL`, which creates the classic Application Load Balancer; Google recommends the newer one for new deployments.

### Reserve a static IP address

```bash
gcloud compute addresses create loadbalancer-ip-1 --global --ip-version IPV4
```

### Allow health checks and load balancer traffic

Google's health checkers and front ends connect from `130.211.0.0/22` and `35.191.0.0/16`:

```bash
gcloud compute firewall-rules create allow-http-loadbalancer \
    --network default \
    --allow tcp:80 \
    --source-ranges 130.211.0.0/22,35.191.0.0/16
```

### Create a health check

The ingress-nginx default server answers `/healthz` with 200 on port 80:

```bash
gcloud compute health-checks create http lb-nginx-health-check \
  --use-serving-port \
  --request-path /healthz \
  --check-interval 10 \
  --timeout 5 \
  --healthy-threshold 1 \
  --unhealthy-threshold 3
```

### Create the backend service and attach the NEG

```bash
gcloud compute backend-services create lb-backend-service \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --protocol=HTTP \
    --health-checks=lb-nginx-health-check \
    --global

# Repeat for every zone listed by the NEG check in Step 1
gcloud compute backend-services add-backend lb-backend-service \
  --network-endpoint-group=ingress-nginx-80-neg-http \
  --network-endpoint-group-zone=us-central1-c \
  --balancing-mode=RATE \
  --max-rate-per-endpoint=100 \
  --global
```

### Create the URL map, proxy and forwarding rule

```bash
gcloud compute url-maps create nginx-loadbalancer \
    --default-service lb-backend-service

gcloud compute target-http-proxies create http-lb-proxy \
    --url-map=nginx-loadbalancer

gcloud compute forwarding-rules create forwarding-rule-01 \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --address=loadbalancer-ip-1 \
    --global \
    --target-http-proxy=http-lb-proxy \
    --ports=80
```

For HTTPS, create a Google-managed or Certificate Manager certificate, a `target-https-proxies` resource and a second forwarding rule on port 443.

## Step 3: Deploy a sample application

```yaml
# httpd.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: httpd
spec:
  replicas: 2
  selector:
    matchLabels:
      app: httpd
  template:
    metadata:
      labels:
        app: httpd
    spec:
      containers:
      - name: httpd
        image: httpd:2.4
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: httpd
spec:
  selector:
    app: httpd
  ports:
  - port: 80
    targetPort: 80
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: httpd
spec:
  ingressClassName: nginx
  rules:
  - host: www.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: httpd
            port:
              number: 80
```

```bash
kubectl apply -f httpd.yaml
LB_IP=$(gcloud compute addresses describe loadbalancer-ip-1 --global --format='value(address)')
curl -v -H 'Host: www.example.com' "http://$LB_IP/"
```

New load balancers can take a few minutes before they return anything other than 404 or 502.

## Step 4: A second, internal ingress controller

Run a separate controller release with its own IngressClass and NEG:

```yaml
# values-internal.yaml
controller:
  service:
    type: ClusterIP
    annotations:
      cloud.google.com/neg: '{"exposed_ports": {"80":{"name": "ingress-nginx-internal-80-neg-http"}}}'
  ingressClassResource:
    name: internal-nginx
    enabled: true
    controllerValue: "k8s.io/internal-ingress-nginx"
```

```bash
helm upgrade --install ingress-nginx-internal ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx-internal --create-namespace \
  -f values-internal.yaml
```

Ingresses for this controller use `ingressClassName: internal-nginx`.

## Step 5: Internal Application Load Balancer and test

A regional internal Application Load Balancer needs a proxy-only subnet in the region, regional resources, and a firewall rule from that subnet:

```bash
REGION=us-central1

gcloud compute networks subnets create proxy-only-subnet \
  --purpose=REGIONAL_MANAGED_PROXY --role=ACTIVE \
  --region=$REGION --network=default --range=10.129.0.0/23

gcloud compute firewall-rules create allow-proxy-only-subnet \
  --network default --allow tcp:80 --source-ranges 10.129.0.0/23

gcloud compute firewall-rules create allow-internal-health-checks \
  --network default --allow tcp:80 --source-ranges 130.211.0.0/22,35.191.0.0/16

gcloud compute health-checks create http internal-nginx-hc \
  --region=$REGION --use-serving-port --request-path /healthz

gcloud compute backend-services create internal-nginx-backend \
  --load-balancing-scheme=INTERNAL_MANAGED --protocol=HTTP \
  --health-checks=internal-nginx-hc --health-checks-region=$REGION \
  --region=$REGION

gcloud compute backend-services add-backend internal-nginx-backend \
  --network-endpoint-group=ingress-nginx-internal-80-neg-http \
  --network-endpoint-group-zone=us-central1-c \
  --balancing-mode=RATE --max-rate-per-endpoint=100 \
  --region=$REGION

gcloud compute url-maps create internal-nginx-map \
  --default-service=internal-nginx-backend --region=$REGION

gcloud compute target-http-proxies create internal-nginx-proxy \
  --url-map=internal-nginx-map --region=$REGION

gcloud compute forwarding-rules create internal-nginx-fr \
  --load-balancing-scheme=INTERNAL_MANAGED \
  --network=default --subnet=default \
  --target-http-proxy=internal-nginx-proxy --target-http-proxy-region=$REGION \
  --region=$REGION --ports=80
```

Test from a VM without a public IP in the same VPC:

```bash
gcloud compute instances create testing-vm-01 \
    --zone=us-central1-c \
    --machine-type=e2-medium \
    --network-interface=subnet=default,no-address

gcloud compute ssh testing-vm-01 --zone us-central1-c --tunnel-through-iap

# On the VM
curl -v -H 'Host: www.example.com' http://<internal-forwarding-rule-ip>/
```

Pick a proxy-only subnet range that does not overlap your existing subnets.

## Alternative: GKE Gateway API

For new work, GKE's built-in Gateway controller provisions the Google load balancer directly from Kubernetes objects, with no controller pods to run or patch. Enable it on the cluster if it is not already on:

```bash
gcloud container clusters update CLUSTER_NAME --location=LOCATION --gateway-api=standard
```

Then create a Gateway and an HTTPRoute:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: external-http
spec:
  gatewayClassName: gke-l7-global-external-managed
  listeners:
  - name: http
    protocol: HTTP
    port: 80
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: httpd
spec:
  parentRefs:
  - name: external-http
  hostnames:
  - "www.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: httpd
      port: 80
```

Use `gatewayClassName: gke-l7-rilb` for an internal (regional) load balancer. Google's migration guide recommends running Ingress and Gateway side by side, testing the Gateway IP with `curl --resolve`, then switching DNS. Feature parity is not complete; for example, URL rewrites on GKE Gateway only support prefix replacement, so check annotations such as `rewrite-target` before migrating.

## FAQ

### Why use standalone NEGs instead of a LoadBalancer Service?

NEGs let the Google load balancer send traffic straight to the controller pods, skipping the extra node hop of a `LoadBalancer` or `NodePort` Service, and let you use Application Load Balancer features such as Cloud Armor and managed certificates in front of NGINX.

### Is ingress-nginx still supported on GKE?

GKE never managed the community ingress-nginx controller; you install and patch it yourself. Since March 2026 upstream no longer ships fixes, so treat existing installs as legacy and plan a move to GKE Gateway API or another maintained controller.

### My backends show unhealthy. What should I check?

That the firewall rule allows `130.211.0.0/22` and `35.191.0.0/16` on port 80, that the health check path is `/healthz`, and that every zone with controller pods has its NEG attached to the backend service.

## Related guides

- [RKE2 Ingress-NGINX: Troubleshooting and 2026 Retirement](/rke2-ingress-nginx/)
- [Troubleshooting k8s Ingress: Ingress-Nginx and Traefik](/post/k8s-ingress-troubleshooting/)
- [ModSecurity on Ingress-NGINX](/modsecurity-kubernetes-ingress-nginx/)
