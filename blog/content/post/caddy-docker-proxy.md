---
title: "Easier Alternative to Nginx + Let’s Encrypt with Caddy Docker Proxy"
date: 2025-06-01T12:00:00-05:00
draft: false
tags: ["Caddy", "Docker", "Proxy", "DevOps", "SSL"]
categories:
- DevOps
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Streamline SSL management and simplify proxy configuration using Caddy Docker Proxy as an alternative to Nginx and Let’s Encrypt."
more_link: "yes"
url: "/caddy-docker-proxy/"
---

Managing SSL certificates and proxying Docker applications has traditionally required a combination of Nginx and Let’s Encrypt. While effective, this setup can feel overly complex for many use cases. Enter **Caddy Docker Proxy**, a tool that simplifies this process, making it ideal for small applications or CI/CD pipelines.

<!--more-->

---

## The Nginx + Let’s Encrypt Approach  

Here’s a typical setup with Nginx and Let’s Encrypt:  

```yaml
services:
  web: 
    image: nginx:latest
    restart: always
    volumes:
      - ./public:/var/www/html
      - ./conf.d:/etc/nginx/conf.d
      - ./certbot/conf:/etc/nginx/ssl
      - ./certbot/data:/var/www/certbot
    ports:
      - 80:80
      - 443:443

  certbot:
    image: certbot/certbot:latest
    command: certonly --webroot --webroot-path=/var/www/certbot --email your-email@domain.com --agree-tos --no-eff-email -d domain.com -d www.domain.com
    volumes:
      - ./certbot/conf:/etc/letsencrypt
      - ./certbot/logs:/var/log/letsencrypt
      - ./certbot/data:/var/www/certbot
```

While functional, this setup involves managing configuration files, running Certbot for SSL, and integrating Nginx for proxying. For many, this is more work than necessary.

---

## The Caddy Docker Proxy Alternative  

Caddy simplifies this entire process by automatically managing SSL certificates and serving as a reverse proxy. Below is an example using Caddy Docker Proxy for a Grafana application:

```yaml
services:
  caddy:
    image: lucaslorentz/caddy-docker-proxy:ci-alpine
    ports:
      - 80:80
      - 443:443
    environment:
      - CADDY_INGRESS_NETWORKS=caddy
    networks:
      - caddy
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - caddy_data:/data
    restart: unless-stopped

  grafana:
    environment:
      GF_SERVER_ROOT_URL: "https://grafana.example.com"
      GF_INSTALL_PLUGINS: "digiapulssi-breadcrumb-panel,grafana-polystat-panel"
    image: grafana/grafana:latest
    restart: unless-stopped
    volumes:
      - grafana-storage:/var/lib/grafana
      - ./grafana/grafana.ini:/etc/grafana/grafana.ini
    networks:
      - caddy
    labels:
      caddy: grafana.example.com
      caddy.reverse_proxy: "{{upstreams 3000}}"
```

---

### How It Works  

1. **Caddy listens on external ports** and proxies traffic to your Docker applications.  
2. **Applications define their domains** using Docker labels (`caddy: your-domain.com`).  
3. Caddy automatically fetches and manages **SSL certificates** for defined domains.  

---

## Example: Hosting a Ghost Blog  

Here’s how to set up a blog using Ghost and Caddy:

```yaml
services:
  ghost:
    image: ghost:latest
    restart: always
    networks:
      - caddy
    environment:
      url: https://example.com
    volumes:
      - /opt/ghost_content:/var/lib/ghost/content
    labels:
      caddy: example.com
      caddy.reverse_proxy: "{{upstreams 2368}}"

  caddy:
    image: lucaslorentz/caddy-docker-proxy:ci-alpine
    ports:
      - 80:80
      - 443:443
    environment:
      - CADDY_INGRESS_NETWORKS=caddy
    networks:
      - caddy
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - caddy_data:/data
    restart: unless-stopped

networks:
  caddy:
    external: true

volumes:
  caddy_data: {}
```

Steps:  

1. Install Docker Compose.  
2. Create a Docker network with:  
   ```bash
   docker network create caddy
   ```
3. Replace `example.com` with your domain.  
4. Run:  
   ```bash
   docker-compose up -d
   ```
5. Visit your domain to configure Ghost.  

---

## Why Use Caddy?  

- **Automation**: SSL certificates are managed automatically.  
- **Simplicity**: Configure apps with Docker labels.  
- **Performance**: Caddy is lightweight and highly efficient.  
- **CI/CD Friendly**: Works seamlessly in automated pipelines.  

---

For small developers and CI/CD setups, Caddy is a game-changer. It offers an easier, more reliable alternative to Nginx + Let’s Encrypt. Give it a try and see how it simplifies your workflow!

For more tips, connect with me on [LinkedIn](https://www.linkedin.com/in/matthewmattox/), [GitHub](https://github.com/mattmattox), or [BlueSky](https://bsky.app/profile/cube8021.bsky.social).
