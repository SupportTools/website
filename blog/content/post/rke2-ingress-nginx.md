---
title: "Ingress-NGINX for RKE2: Overview, Troubleshooting, and Common Configurations"
date: 2025-01-22T00:00:00-05:00
draft: false
tags: ["RKE2", "Kubernetes", "Ingress"]
categories:
- RKE2
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth guide to understanding RKE2's Ingress-NGINX, troubleshooting it, and configuring it effectively."
more_link: "yes"
url: "/rke2-ingress-nginx/"
---

RKE2's Ingress-NGINX controller is a powerful solution for managing incoming HTTP and HTTPS traffic in Kubernetes clusters. This guide explores its architecture, troubleshooting techniques, common configurations, and practical examples.

<!--more-->

# Ingress-NGINX for RKE2

## How Ingress-NGINX Works for RKE2

### Architecture
RKE2 uses the Ingress-NGINX controller to expose services running within the Kubernetes cluster to the external world. Key components include:

1. **Ingress Resource**: Defines the routing rules for HTTP/HTTPS traffic to the backend services.
2. **Ingress-NGINX Controller Pod**: Manages the routing based on Ingress definitions and configures NGINX accordingly.
3. **Load Balancer Integration**: In many environments, RKE2 integrates with cloud load balancers or external load balancers to handle traffic distribution.

The controller watches for changes in the Ingress resource, configures NGINX dynamically, and ensures traffic is routed correctly.

---

## Troubleshooting RKE2 Ingress-NGINX

### Common Errors and Their Resolutions

#### **Backend Service is Offline**
- **Cause**: The service or pod associated with the Ingress is not running or misconfigured.
- **Symptoms**: 
  - Requests result in a 502 Bad Gateway error.
  - NGINX logs show upstream connection errors.
- **Resolution**:
  - Verify the service and pod status using `kubectl get svc` and `kubectl get pods`.
  - Check that the service has the correct selector labels to match the pods.
  - Use `kubectl describe svc <service-name>` to ensure proper configuration.

#### **HTTP Requests Going to an HTTPS Port**
- **Cause**: The Ingress resource or service is misconfigured to accept HTTPS traffic on an HTTP port.
- **Symptoms**:
  - Requests fail with SSL handshake errors or invalid protocol errors.
- **Resolution**:
  - Check the `tls` section in your Ingress resource to ensure HTTPS is configured correctly.
  - Verify the service port definitions in your deployment or service manifest.
  - Use `curl -v http://<host>` or `curl -vk https://<host>` to test the connection.
  - Verify the external load balancer port mappings are correct IE 80 to NodePort XXXXX to Service Port 80.

#### **Misconfigured TLS Certificates**
- **Cause**: The TLS secret is missing, in the wrong namespace, or improperly configured.
- **Symptoms**:
  - Browsers show warnings for an invalid or untrusted certificate.
  - Logs display errors about missing or incorrect certificates.
- **Resolution**:
  - Confirm the TLS secret exists using `kubectl get secret <secret-name> -n <namespace>`.
  - Verify the secret contains valid `tls.crt` and `tls.key` files.
  - Ensure the secret is in the same namespace as the Ingress resource.
  - Test the certificate with OpenSSL: `openssl x509 -in <tls.crt> -text -noout`.
  - Verify the certificate chain and expiration date.
  - Check that the certificate applies to the correct hostname. For example, ingress host `example.com` should match the certificate's Common Name or Subject Alternative Name (SAN).

#### **Requests Falling Back to Default Backend**
- **Cause**: No matching Ingress rule is found for the requested hostname or path.
- **Symptoms**:
  - Requests are routed to the default backend instead of the intended service.
- **Resolution**:
  - Verify that the `host` and `path` in the Ingress resource match the incoming request.
  - Use `kubectl describe ingress <name>` to check the rules.
  - Add the `disable-catch-all: true` argument to prevent default backend fallback.

#### **NGINX Pod Crashes**
- **Cause**: Misconfigured ConfigMap, insufficient resources, or unsupported settings.
- **Symptoms**:
  - NGINX pods repeatedly restart or fail to start.
  - Logs show errors related to configuration files or resource limits.
- **Resolution**:
  - Check logs using `kubectl logs -n ingress-nginx <pod-name>`.
  - Validate the ConfigMap with `kubectl describe cm <configmap-name>`.
  - Increase resource limits in the deployment spec if necessary.

#### **Misconfigured ingress**
- **Cause**: Incorrect or missing annotations, paths, or backend service definitions.
- **Symptoms**:
  - Requests result in 404 Not Found or 503 Service Unavailable errors.
  - Logs show NGINX configuration errors or warnings.
  - Ingress pods crash or restart frequently.
- **Resolution**:
    - Review the Ingress resource for typos or missing fields.
    - Check annotations for NGINX-specific settings.
    - Ensure the backend service is correctly defined and reachable.
    - Verify the validatingwebhookconfiguration is enabled and functioning correctly to catch misconfigurations.

#### 
---

## RKE2 Helm Config

To deploy and customize the Ingress-NGINX controller in an RKE2 cluster, you use `HelmChartConfig`. Below is an example configuration and an explanation of each option.

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
      hostNetwork: true
      config:
        use-forwarded-headers: true
        allow-snippet-annotations: true
        enable-brotli: true
        enable-vts-status: true
      extraArgs:
        publish-status-address: "11.22.33.44"
        default-ssl-certificate: "kube-system/wildcard-tls"
        enable-ssl-passthrough: true
        report-status-classes: true
        disable-catch-all: true
      service:
        enabled: true
        type: LoadBalancer
      metrics:
        enabled: true
        service:
          annotations:
            prometheus.io/scrape: "true"
            prometheus.io/port: "10254"
          labels:
            app.kubernetes.io/name: ingress-nginx
          enabled: true
          port: 10254
        prometheusRule:
          enabled: false
      allowSnippetAnnotations: true
      enableTopologyAwareRouting: true
      podAnnotations:
        "prometheus.io/scrape": "true"
        "prometheus.io/port": "10254"
```

---

### Breakdown of `HelmChartConfig`

#### **Metadata**
- **`name`**: Specifies the name of the Helm chart configuration. In this case, it configures the `rke2-ingress-nginx` chart.
- **`namespace`**: Defines the namespace where the `HelmChartConfig` resides, typically `kube-system` for RKE2 system components.

---

#### **Controller**
Settings that customize how the Ingress-NGINX controller operates:

- **`hostNetwork: true`**:
  - Runs the NGINX pods in the host network namespace, enabling direct access to host ports and improving network performance.
  
- **`config`**:
  - **`use-forwarded-headers: true`**:
    - Ensures that headers like `X-Forwarded-For` are trusted, preserving the client’s original IP address.
  - **`allow-snippet-annotations: true`**:
    - Enables users to add custom NGINX configurations through annotations on Ingress resources.
  - **`enable-brotli: true`**:
    - Enables Brotli compression, which reduces the size of transmitted data for faster page loads.
  - **`enable-vts-status: true`**:
    - Adds the virtual server traffic status (VTS) module for better traffic monitoring.

---

#### **Extra Arguments**
Allows additional arguments to be passed to the NGINX controller:

- **`publish-status-address: "11.22.33.44"`**:
  - Configures the external IP address used to publish the Ingress status.
  
- **`default-ssl-certificate: "kube-system/wildcard-tls"`**:
  - Sets the default SSL certificate for HTTPS traffic. Useful when no specific certificate is defined in the Ingress resource.

- **`enable-ssl-passthrough: true`**:
  - Allows encrypted traffic (HTTPS) to be passed directly to the backend without termination at the Ingress.

- **`report-status-classes: true`**:
  - Enables HTTP status code breakdowns in metrics. For example, you can see 2XX, 3XX, 4XX, and 5XX response counts grouped together instead individual status codes.

- **`disable-catch-all: true`**:
  - Prevents requests without matching Ingress rules from being routed to the default backend, improving security and performance.

---

#### **Service**
Configures how the Ingress controller service is exposed:

- **`enabled: true`**:
  - Ensures the service is deployed.

- **`type: LoadBalancer`**:
  - Exposes the Ingress controller using an external load balancer.

---

#### **Metrics**
Configures Prometheus metrics for the NGINX controller:

- **`enabled: true`**:
  - Turns on the metrics endpoint.
  
- **`service`**:
  - **`annotations`**:
    - Adds annotations for Prometheus to scrape metrics from the service.
  - **`port: 10254`**:
    - Defines the port on which the metrics are exposed.
  - **`labels`**:
    - Assigns labels for better organization in Prometheus.

- **`prometheusRule.enabled: false`**:
  - Disables default Prometheus alert rules, allowing you to define custom rules.

---

#### **Allow Snippet Annotations**
- **`allowSnippetAnnotations: true`**:
  - Enables fine-grained customizations for specific Ingress resources using annotations.

---

#### **Enable Topology-Aware Routing**
- **`enableTopologyAwareRouting: true`**:
  - Optimizes traffic distribution by routing requests based on topology, such as geographic proximity or network distance.

---

#### **Pod Annotations**
- **`"prometheus.io/scrape": "true"`**:
  - Enables Prometheus to scrape metrics from the NGINX pods.
- **`"prometheus.io/port": "10254"`**:
  - Specifies the port Prometheus should use to scrape metrics.

---

### Summary of Benefits

- **Flexibility**: Enables fine-grained control over NGINX behavior, such as SSL passthrough, Brotli compression, and custom annotations.
- **Observability**: Built-in Prometheus metrics and VTS support for monitoring traffic and backend performance.
- **Performance**: Host networking and Brotli compression improve efficiency and speed.
- **Security**: Default SSL certificate and `disable-catch-all` improve HTTPS support and prevent unexpected traffic routing.

---

## Example Ingress Configurations

### Simple Ingress

This basic example demonstrates how to expose a service using HTTP:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: simple-ingress
  namespace: default
spec:
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

- **`host`**: Specifies the domain name for routing traffic.
- **`path`**: Routes all traffic under `/` to the specified service.
- **`service.name`**: The name of the backend service.
- **`service.port.number`**: The port on which the backend service is listening.

---

### Ingress with `ingress-nginx` Extra Settings

This example demonstrates advanced configuration with additional NGINX-specific settings:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: advanced-ingress
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "30s"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "30s"
    nginx.ingress.kubernetes.io/enable-brotli: "true"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "X-Custom-Header: CustomValue";
spec:
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
  - `nginx.ingress.kubernetes.io/rewrite-target`: Rewrites all incoming paths to `/`.
  - `nginx.ingress.kubernetes.io/proxy-body-size`: Sets the maximum allowed size for the request body.
  - `nginx.ingress.kubernetes.io/proxy-read-timeout`: Defines the timeout for reading responses from the backend.
  - `nginx.ingress.kubernetes.io/proxy-send-timeout`: Defines the timeout for sending requests to the backend.
  - `nginx.ingress.kubernetes.io/enable-brotli`: Enables Brotli compression for faster content delivery.
  - `nginx.ingress.kubernetes.io/configuration-snippet`: Adds custom NGINX configurations, such as setting headers.

- **TLS**:
  - Configures HTTPS by referencing the `tls-secret` for the `advanced.example.com` domain.

---

## Adding the NGINX Grafana Dashboard

Monitoring the performance of the NGINX controller is essential for understanding traffic patterns, backend response times, and overall health. Grafana provides a pre-built dashboard for NGINX metrics that integrates seamlessly with Prometheus.

### Step 1: Enable Metrics in Ingress-NGINX

Ensure metrics are enabled in your Ingress-NGINX configuration. Here’s an example of the relevant configuration in `HelmChartConfig`:

```yaml
metrics:
  enabled: true
  service:
    annotations:
      prometheus.io/scrape: "true"
      prometheus.io/port: "10254"
    port: 10254
```

### Step 2: Import the NGINX Grafana Dashboard

Grafana maintains a library of pre-built dashboards, including one specifically for NGINX. Use the following steps to import it:

1. **Find the Dashboard**:
   - Visit the [Grafana Dashboard Repository](https://grafana.com/grafana/dashboards) and search for "NGINX".
   - For Ingress-NGINX, the commonly used dashboard ID is **9614**.

2. **Import the Dashboard**:
   - Open Grafana and log in.
   - Navigate to **Dashboards > Import**.
   - Enter the dashboard ID **9614** or upload the JSON file downloaded from the Grafana website.
   - Click **Load**.

3. **Configure Data Source**:
   - In the "Options" section of the import screen, select your Prometheus data source.
   - Complete the import process.

### Step 3: Explore the Metrics

Once the dashboard is imported, you’ll gain insights into the following key metrics:
- **Requests per Second (RPS)**:
  - Displays incoming HTTP/HTTPS traffic rates.
- **Latency**:
  - Measures request response times from the NGINX controller and backend services.
- **Active Connections**:
  - Shows the number of active client connections to the NGINX controller.
- **HTTP Status Codes**:
  - Tracks the distribution of HTTP status codes (e.g., 200, 404, 500) for troubleshooting errors.

### Step 4: Customize the Dashboard

You can customize the dashboard to include additional panels or filters specific to your environment:
- Add filters for namespaces or Ingress names.
- Create alerts for high response times or error rates.

---

### Example Panel Query

To visualize the rate of HTTP requests, use this example Prometheus query:

```promql
rate(nginx_ingress_controller_requests{namespace="ingress-nginx"}[1m])
```

This query calculates the per-second rate of requests handled by the NGINX controller, filtered by the namespace.

---

### Benefits of Using the NGINX Grafana Dashboard

- **Improved Observability**: Gain real-time insights into traffic and backend performance.
- **Troubleshooting**: Identify bottlenecks, high latency, or error rates quickly.
- **Scalability**: Monitor trends to plan scaling or resource allocation for the NGINX controller.

---

## Conclusion

RKE2's Ingress-NGINX controller simplifies traffic management in Kubernetes, offering powerful features for routing and customization. With the troubleshooting tips, recommended configuration, and examples provided, you can build robust and efficient ingress solutions tailored to your needs.

---