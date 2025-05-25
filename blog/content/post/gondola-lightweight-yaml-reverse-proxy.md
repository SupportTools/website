---
title: "Gondola: A Lightweight YAML-Based Reverse Proxy for Modern Web Applications"
date: 2026-08-11T09:00:00-05:00
draft: false
tags: ["Go", "DevOps", "Reverse Proxy", "Kubernetes", "Networking", "Web Server"]
categories:
- DevOps
- Networking
- Go
author: "Matthew Mattox - mmattox@support.tools"
description: "Exploring Gondola, a minimalist yet powerful Go-based reverse proxy that simplifies configuration with YAML and provides essential features for modern web applications"
more_link: "yes"
url: "/gondola-lightweight-yaml-reverse-proxy/"
---

For many DevOps engineers and site reliability engineers, configuring reverse proxies can be unnecessarily complex. Gondola offers a refreshing alternative - a lightweight, YAML-based reverse proxy written in Go that provides just enough features without the complexity of larger solutions.

<!--more-->

# [Introduction to Gondola](#introduction)

In the world of web application infrastructure, reverse proxies serve as critical components for routing traffic, providing TLS termination, serving static assets, and more. While powerful options like Nginx and HAProxy dominate the space, their configuration complexity can be overkill for simpler use cases.

[Gondola](https://github.com/bmf-san/gondola) is an open-source reverse proxy built in Go that takes a different approach - simplifying configuration through YAML while still providing essential features for modern web applications. It aims to offer a lightweight alternative that's both easy to understand and quick to deploy.

## [Key Features](#key-features)

Gondola offers a focused set of features that cover most common reverse proxy needs:

1. **Virtual Host Support**: Route traffic to different upstream servers based on the host header
2. **Simple YAML Configuration**: Configure your proxy through straightforward YAML files
3. **TLS Support**: Easily enable HTTPS with certificate and key files
4. **Static File Serving**: Serve static assets directly without an upstream server
5. **Comprehensive Logging**: Detailed access logs for both proxy and upstream servers
6. **Cross-Platform Support**: Available as pre-compiled binaries for various platforms

## [Why Consider a Lightweight Alternative?](#why-lightweight)

Not every deployment requires a full-featured proxy with complex configuration options. Here are some scenarios where a lightweight reverse proxy like Gondola makes sense:

- **Simple Blog or Website Hosting**: When routing traffic to a few backend services
- **Development Environments**: Quick setup for local testing with multiple services
- **Microservices in Small Teams**: When you need simple routing without complex rules
- **Edge Deployments**: Where resources may be constrained
- **Containerized Applications**: As a minimal sidecar for service routing

# [Getting Started with Gondola](#getting-started)

Let's walk through how to set up and configure Gondola for a basic reverse proxy scenario.

## [Installation](#installation)

You can install Gondola in several ways:

**Using Go:**

```bash
go install github.com/bmf-san/gondola@latest
```

**Download a Binary:**

```bash
# For Linux (amd64)
curl -L https://github.com/bmf-san/gondola/releases/latest/download/gondola-linux-amd64 -o gondola
chmod +x gondola
```

**Using Docker:**

```bash
docker pull bmfsan/gondola:latest
```

## [Basic Configuration](#basic-configuration)

Gondola's configuration is defined in a YAML file. Here's a basic example that routes traffic to two different backend servers based on the hostname:

```yaml
proxy:
  port: 80
  read_header_timeout: 2000  # milliseconds
  shutdown_timeout: 3000     # milliseconds

upstreams:
  - host_name: api.example.com
    target: http://api-server:8080
  
  - host_name: blog.example.com
    target: http://blog-server:3000

log_level: 0  # Debug:-4 Info:0 Warn:4 Error:8
```

## [Starting the Proxy](#starting-proxy)

Once you've created your configuration file, start Gondola with:

```bash
gondola -config config.yaml
```

Or with Docker:

```bash
docker run -v $(pwd)/config.yaml:/config.yaml \
  -p 80:80 \
  bmfsan/gondola:latest -config /config.yaml
```

# [Advanced Configuration Examples](#advanced-configuration)

Let's explore some more advanced configuration scenarios with Gondola.

## [Enabling TLS](#enabling-tls)

To enable HTTPS, simply provide the paths to your certificate and key files:

```yaml
proxy:
  port: 443
  read_header_timeout: 2000
  shutdown_timeout: 3000
  tls_cert_path: /path/to/cert.pem
  tls_key_path: /path/to/key.pem

upstreams:
  - host_name: secure.example.com
    target: http://secure-backend:8443
```

## [Serving Static Files](#serving-static-files)

Gondola can directly serve static files without forwarding to an upstream server:

```yaml
proxy:
  port: 80
  read_header_timeout: 2000
  shutdown_timeout: 3000
  static_files:
    - path: /assets/
      dir: ./public/assets
    - path: /images/
      dir: ./public/images

upstreams:
  - host_name: example.com
    target: http://app-server:8080
```

With this configuration, requests to `http://example.com/assets/*` and `http://example.com/images/*` will be served directly from the corresponding local directories, while all other requests will be forwarded to the upstream server.

## [Multiple Backends for Load Distribution](#multiple-backends)

While Gondola doesn't currently include built-in load balancing, you can achieve simple load distribution by configuring multiple upstream servers for the same host:

```yaml
upstreams:
  - host_name: api.example.com
    target: http://api-server1:8080
  
  - host_name: api.example.com
    target: http://api-server2:8080
```

Note that this is not true load balancing as it doesn't handle health checks, but it can be useful in simple scenarios with other tools handling server health.

# [Deploying Gondola in Production](#production-deployment)

## [Docker Compose Example](#docker-compose)

Here's a Docker Compose configuration for deploying Gondola with a web application:

```yaml
version: '3'

services:
  gondola:
    image: bmfsan/gondola:latest
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./config.yaml:/config.yaml
      - ./certificates:/certificates
    command: -config /config.yaml
    restart: always
    depends_on:
      - webapp

  webapp:
    image: my-webapp:latest
    expose:
      - "8080"
```

## [Kubernetes Deployment](#kubernetes-deployment)

For Kubernetes deployments, here's a basic manifest:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gondola-config
data:
  config.yaml: |
    proxy:
      port: 80
      read_header_timeout: 2000
      shutdown_timeout: 3000
    
    upstreams:
      - host_name: example.com
        target: http://webapp-service:8080
    
    log_level: 0

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gondola-proxy
spec:
  replicas: 2
  selector:
    matchLabels:
      app: gondola-proxy
  template:
    metadata:
      labels:
        app: gondola-proxy
    spec:
      containers:
      - name: gondola
        image: bmfsan/gondola:latest
        args:
        - "-config"
        - "/etc/gondola/config.yaml"
        ports:
        - containerPort: 80
        volumeMounts:
        - name: config
          mountPath: /etc/gondola
      volumes:
      - name: config
        configMap:
          name: gondola-config

---
apiVersion: v1
kind: Service
metadata:
  name: gondola-proxy
spec:
  selector:
    app: gondola-proxy
  ports:
  - port: 80
    targetPort: 80
  type: ClusterIP

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: gondola-ingress
spec:
  rules:
  - host: example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: gondola-proxy
            port:
              number: 80
```

# [Building Your Own Reverse Proxy with Go](#building-your-own)

Gondola is built using only Go's standard library, making it an excellent learning resource. Let's explore how you can implement a basic reverse proxy in Go:

```go
package main

import (
    "log"
    "net/http"
    "net/http/httputil"
    "net/url"
)

func main() {
    // Target URL to proxy to
    target, err := url.Parse("http://localhost:8080")
    if err != nil {
        log.Fatal(err)
    }

    // Create reverse proxy
    proxy := httputil.NewSingleHostReverseProxy(target)

    // Create a handler function
    handler := func(w http.ResponseWriter, r *http.Request) {
        // Update request Host header to match target
        r.Host = target.Host
        
        // Log the request
        log.Printf("Proxying request: %s %s", r.Method, r.URL.Path)
        
        // Proxy the request
        proxy.ServeHTTP(w, r)
    }

    // Start server
    log.Println("Starting proxy server on :80")
    if err := http.ListenAndServe(":80", http.HandlerFunc(handler)); err != nil {
        log.Fatal(err)
    }
}
```

This is a simplified example, but it demonstrates the core functionality of a reverse proxy. Gondola expands on this by adding virtual hosts, configuration loading, TLS support, and more.

# [Comparison with Other Reverse Proxies](#comparison)

To help determine if Gondola is right for your needs, here's how it compares to other popular reverse proxies:

| Feature | Gondola | Nginx | Traefik | HAProxy |
|---------|---------|-------|---------|---------|
| Configuration Format | YAML | Text-based | YAML/TOML/Auto-discovery | Text-based |
| Learning Curve | Low | Medium-High | Medium | High |
| Resource Usage | Very Light | Light | Medium | Light |
| Built-in Load Balancing | No | Yes | Yes | Yes |
| Auto SSL | No | With modules | Yes | No |
| Dynamic Config Reloading | No (Planned) | Partial | Yes | Yes |
| WebSocket Support | Yes | Yes | Yes | Yes |
| Metrics/Monitoring | No | With modules | Yes | Yes |
| Community Size | Small | Very Large | Large | Very Large |

## [When to Choose Gondola](#when-to-choose)

Gondola is an excellent choice when:

1. **Simplicity is a priority**: You want a tool that's easy to configure and understand
2. **Resource constraints exist**: You need a proxy with minimal overhead
3. **Basic proxying features are sufficient**: Your needs are covered by virtual hosts, TLS, and static file serving
4. **You prefer YAML configuration**: You want a more structured, modern config format
5. **You're building on Go**: You appreciate Go's cross-platform compatibility and deployment simplicity

# [Future Roadmap and Contributing](#future-roadmap)

The Gondola project is actively developing several features:

1. **Graceful shutdown**: Improve handling of in-flight requests during restart
2. **Upstream health checks**: Automatically detect and avoid unhealthy backends
3. **Configuration file reload**: Update settings without restarting
4. **Communication optimization**: Improve performance for various traffic patterns
5. **Load balancing**: Add built-in load distribution capabilities

If you're interested in contributing to Gondola, there are several ways to get involved:

- **Star the repository**: Show your support on GitHub
- **Report issues**: Help identify bugs or suggest features
- **Submit pull requests**: Contribute code improvements
- **Improve documentation**: Help make Gondola more accessible to new users

# [Conclusion](#conclusion)

Gondola represents a refreshing approach to reverse proxies - providing essential functionality with minimal complexity. Its straightforward YAML configuration, lightweight resource footprint, and focus on core features make it an appealing option for many web applications.

While it may not replace more full-featured proxies like Nginx or Traefik in complex environments, Gondola excels in scenarios where simplicity and ease of use are prioritized. Its Go implementation also makes it particularly portable across different platforms and deployment strategies.

Whether you're looking for a simpler reverse proxy solution or interested in learning how such tools work, Gondola is worth considering for your next project. As the project continues to evolve, it maintains a balance between adding useful features and preserving the simplicity that makes it stand out from more complex alternatives.