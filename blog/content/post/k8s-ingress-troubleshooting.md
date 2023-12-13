---
title: "Troubleshooting k8s Ingress: Ingress-Nginx and Traefik"
date: 2023-12-13T06:00:00-05:00
draft: false
tags: ["kubernetes", "rancher", "ingress-nginx", "traefik"]
categories:
- Kubernetes
- Rancher
author: "Matthew Mattox - mmattox@support.tools."
description: "A comprehensive guide for troubleshooting Kubernetes Ingress using Ingress-Nginx and Traefik with Rancher."
more_link: "yes"
---

In the world of Kubernetes (k8s), setting up and maintaining Ingress controllers like Ingress-Nginx and Traefik is crucial for managing external access to your cluster's services. However, troubleshooting these can be a daunting task. This post aims to simplify that process, offering practical solutions for common issues faced with k8s Ingress, especially in a Rancher-managed environment.

<!--more-->

## Understanding Ingress in Kubernetes

Kubernetes Ingress is a powerful tool for managing external access to services within your cluster. It provides HTTP and HTTPS routing to services based on domain names and paths. Ingress-Nginx and Traefik are two popular Ingress controllers that manage these routing rules. And are provided as part of the RKE1/RKE2 and K3s distributions of Kubernetes.

RKE1 and RKE2 provide Ingress-Nginx as the default Ingress controller. K3s, on the other hand, uses Traefik. Both of these controllers are highly configurable and can be customized to suit your needs.

## Differences Between Ingress-Nginx and Traefik

When troubleshooting Kubernetes Ingress, understanding the key differences between Ingress-Nginx and Traefik is essential. While both serve the primary purpose of managing external access to services in a Kubernetes cluster, they differ in architecture, features, and operational approaches.

### Architectural Differences

#### Ingress-Nginx

- **Built on Nginx**: Ingress-Nginx is based on the widely-used Nginx web server and reverse proxy. It is known for its performance and reliability.
- **Annotation-Based Configuration**: Offers extensive customization through annotations in Ingress resource definitions.

### Traefik

- **Dynamic Configuration**: Traefik is designed to automatically discover and manage services and their routes. It dynamically adjusts its configuration without requiring restarts.
- **Middleware Support**: Traefik provides support for middlewares which can manipulate the request before it reaches the service.

### Feature Comparison

#### Performance and Scalability

- **Ingress-Nginx**: Known for high performance, particularly under heavy load. It scales well but might require manual tuning for optimal performance.
- **Traefik**: Designed for ease of scalability, especially in dynamic environments. It can automatically adjust to changes in the cluster.

#### User Interface and Dashboard

- **Ingress-Nginx**: Lacks a built-in UI for monitoring and management.
- **Traefik**: Comes with a built-in dashboard for real-time monitoring and management of routes and services.

#### Configuration Ease and Flexibility

- **Ingress-Nginx**: Offers a high degree of control through annotations, but might require more Kubernetes-specific knowledge.
- **Traefik**: Prioritizes simplicity and ease of use, with less Kubernetes-specific configuration required.

#### SSL/TLS Management

- Both Ingress-Nginx and Traefik support SSL/TLS termination and can be configured to use Let's Encrypt for automatic certificate management. However, their configuration approaches and capabilities in handling certificates may vary.

#### Load Balancing Features

- **Ingress-Nginx**: Provides advanced load balancing features, such as session persistence and custom load balancing algorithms.
- **Traefik**: Offers basic load balancing capabilities, focusing more on simplicity and automation.

### Choosing the Right Ingress Controller

The choice between Ingress-Nginx and Traefik largely depends on the specific needs of your Kubernetes environment. Consider factors such as:

- **Complexity of the Environment**: For more complex routing needs and fine-tuned control, Ingress-Nginx might be the better choice. For simpler, more dynamic environments, Traefik's automatic service discovery and configuration might be more beneficial.
- **Performance Requirements**: If performance under high load is a critical factor, Ingress-Nginx's robustness may be preferable.
- **Ease of Use and Maintenance**: For teams looking for ease of use and minimal maintenance, Traefik's dynamic configuration and built-in dashboard can be advantageous.

## Common Challenges with Ingress Controllers

Despite their utility, setting up and troubleshooting these controllers can be complex. Common issues include misconfigured routing rules, SSL/TLS certificate problems, and networking challenges within the Kubernetes cluster.

## Key Steps for Troubleshooting Ingress

Troubleshooting Ingress in Kubernetes requires a systematic approach. Here are some key steps to follow:

### Remove Ingress from the Equation

If you are facing issues with Ingress, it is best to remove it from the equation and test the service directly. This will help you isolate the problem and determine if it is related to Ingress or the service itself.

You can do this by creating a NodePort service and accessing it directly through the node's IP address and port. For example:

Create a NodePort service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: hello-world
spec:
    type: NodePort
    selector:
        app: hello-world
    ports:
        - name: http
        port: 80
        targetPort: 80
```

Get the service's NodePort:

```bash
kubectl get svc hello-world -o wide
```

Connect to the service:

```bash
curl http://<node-ip>:<node-port>
```

Another option is to use the `kubectl port-forward` command to forward the service port to your local machine. For example:

```bash
kubectl port-forward svc/hello-world 8080:80
```

```bash
curl http://localhost:8080
```

### Validating Configuration Files

- **Syntax Check**: Ensure your Ingress resource definitions are correctly formatted.
- **Routing Rules**: Verify the routing rules are correctly pointing to the right services and paths.

### Checking Controller Logs

- **Ingress-Nginx**: Examine logs for errors or misconfigurations (`kubectl logs -n ingress-nginx <nginx-ingress-controller-pod>`).
- **Traefik**: Check Traefik logs for insightful debugging information.

### Increasing Logging Verbosity

For RKE1, you can increase the verbosity of Ingress-Nginx logs by editing the `nginx-ingress-controller` DaemonSet and setting the `--v` flag to `5` or higher. For example:

```bash
kubectl edit daemonset nginx-ingress-controller -n ingress-nginx
```


```yaml
      containers:
        - args:
            - /nginx-ingress-controller
            - '--v=5'
            - '--election-id=ingress-controller-leader-nginx'
            - '--controller-class=k8s.io/ingress-nginx'
```

Note this will be overwritten on the next cluster update. If you need this to persist, you can edit the cluster.yaml and add the following:

```yaml
ingress:
  provider: nginx
  extra_args:
    v: 5
```

For RKE2, you can increase the verbosity of Ingress-Nginx logs by editing the `nginx-ingress-controller` DaemonSet and setting the `--v` flag to `5` or higher. For example:

```bash
kubectl edit daemonset rke2-ingress-nginx-controller -n kube-system
```

```yaml
    spec:
      containers:
        - args:
            - /nginx-ingress-controller
            - '--v=5'
            - '--election-id=rke2-ingress-nginx-leader'
            - '--controller-class=k8s.io/ingress-nginx'
```

Note this will be overwritten on the next cluster update. If you need this to persist, you can edit the RKE2 manifest and add the following:

```yaml
# /var/lib/rancher/rke2/server/manifests/rke2-ingress-nginx-config.yaml
---
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-ingress-nginx
  namespace: kube-system
spec:
  valuesContent: |-
    controller:
        extraArgs:
            v: 5
```

For K3s, you can increase the verbosity of Traefik logs by editing the `traefik` DaemonSet and setting the `--log.level` flag to `DEBUG`. For example:

```bash
kubectl edit deployment traefik -n kube-system
```

```yaml
containers:
  - args:
    - --log.level=DEBUG
```

### Inspecting Certificates and TLS Configurations

One of the most common issues with Ingress controllers is SSL/TLS certificate problems.

- **Invalid Certificates**: Check if the certificates are valid and not expired.

Example output:

```bash
W1213 13:01:31.385397       7 backend_ssl.go:47] Error obtaining X.509 certificate: unexpected error creating SSL Cert: no valid PEM formatted block found
W1213 13:01:31.391841       7 controller.go:1372] Error getting SSL certificate "default/bad-cert": local SSL certificate default/bad-cert was not found. Using default certificate
```

- **Certificate Mismatch**: Ensure the certificate matches the domain name in the Ingress resource definition.

Example output:

```bash
W1213 13:03:36.205196       7 controller.go:1387] Validating certificate against DNS names. This will be deprecated in a future version
W1213 13:03:36.205245       7 controller.go:1392] SSL certificate "default/star" does not contain a Common Name or Subject Alternative Name for server "hello-world2.example.com": x509: certificate is valid for *.support.tools, support.tools, not hello-world2.example.com
```

### Network Troubleshooting

- **DNS Resolution**: Confirm that your domain names correctly resolve to your cluster's external IP.
- **Cluster DNS**: Check if the cluster's DNS is working correctly.
- **Firewall Rules**: Check if firewalls are blocking necessary ports. For example, Rancher project network policy rules block all ingress traffic by default.
- **Endpoint Connectivity**: Ensure the endpoints are reachable from the cluster. ```kubectl get endpoints``` can be used to check the endpoints.

### Monitoring and Probes

- **Prometheus**: Use Prometheus to monitor the health of your Ingress controllers.
- **Grafana**: Grafana can be used to visualize Prometheus metrics and provide insights into the health of your Ingress controllers.

## Conclusion

Troubleshooting Ingress in Kubernetes, especially with controllers like Ingress-Nginx and Traefik, is a multifaceted task. By following systematic steps and understanding the intricacies of these controllers, you can effectively manage and resolve issues in your k8s environment. Remember, a well-configured Ingress is key to a robust and accessible Kubernetes cluster.

For more detailed guides and support, visit [Rancher documentation](https://rancher.com/docs/) and the official [Kubernetes Ingress-Nginx](https://kubernetes.github.io/ingress-nginx/) and [Traefik](https://doc.traefik.io/traefik/) documentation pages.
