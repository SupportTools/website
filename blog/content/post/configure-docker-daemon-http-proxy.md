---
title: "Configure Docker Daemon to Use HTTP Proxy"  
date: 2024-09-04T19:26:00-05:00  
draft: false  
tags: ["Docker", "Proxy", "HTTP Proxy", "Corporate Network"]  
categories:  
- Docker  
- Networking  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to configure Docker to use an HTTP proxy within a corporate network."  
more_link: "yes"  
url: "/configure-docker-daemon-http-proxy/"  
---

In corporate environments, Docker deployments often face restrictions on direct Internet access, requiring the use of a proxy for outbound connections. This guide will show you how to configure Docker to use an HTTP proxy.

<!--more-->

### The Problem

Docker has been deployed inside a corporate network, but direct Internet access is restricted. Instead, all outbound traffic must pass through a Squid HTTP proxy located at `http://proxy.example.test:3128`.

### The Solution

Docker can be configured to use HTTP, HTTPS, and NO_PROXY environmental variables to ensure that traffic routes through the proxy. Here’s how to set it up.

### Docker with HTTP Proxy

#### 1. Create a systemd directory for Docker

To configure Docker to use the HTTP proxy, create a new systemd directory for the Docker service:

```bash
# mkdir -p /etc/systemd/system/docker.service.d
```

#### 2. Create the HTTP proxy configuration file

Now, create a file named `http-proxy.conf` and define the proxy environment variables. Ensure that internal requests to `127.0.0.1` and `localhost` bypass the proxy:

```bash
# cat > /etc/systemd/system/docker.service.d/http-proxy.conf << EOF
[Service]
Environment="HTTP_PROXY=http://proxy.example.test:3128"
Environment="HTTPS_PROXY=http://proxy.example.test:3128"
Environment="NO_PROXY=127.0.0.1,localhost"
EOF
```

#### 3. Restart Docker

To apply the changes, reload the systemd daemon and restart the Docker service:

```bash
# systemctl daemon-reload
# systemctl restart docker
```

#### 4. Verify the Proxy Settings

You can verify that the proxy settings have been applied by checking Docker’s environment variables:

```bash
# systemctl show --property=Environment docker
```

### Final Thoughts

Configuring Docker to use an HTTP proxy is essential for environments with restricted Internet access. By setting up Docker to use these environment variables, you can ensure that outbound traffic is routed properly through the proxy without hindering internal communication.
