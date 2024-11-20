---
title: "Setting Up a Reverse Proxy with Nginx and Docker-Compose"
date: 2024-11-21T05:00:00-05:00
draft: false
tags: ["nginx", "docker-compose", "reverse-proxy", "devops"]
categories:
- DevOps
- Nginx
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to set up a reverse proxy with Nginx and Docker-Compose. This step-by-step guide includes configuration for SSL, caching, and multiple services."
more_link: "yes"
url: "/nginx-docker-compose-reverse-proxy/"
---

Setting up a reverse proxy with **Nginx** and **Docker-Compose** is an essential skill for DevOps and developers. A reverse proxy enhances application performance, security, and scalability by managing tasks like SSL termination, caching, and request routing—all while isolating your application.

<!--more-->

# [Setting Up a Reverse Proxy with Nginx and Docker-Compose](#setting-up-a-reverse-proxy-with-nginx-and-docker-compose)

## Introduction  

Reverse proxies like **Nginx** enable you to manage critical web application functionalities such as SSL encryption, caching, and service isolation. By handling these tasks outside of your application, Nginx ensures a secure and streamlined setup. Pairing this with **Docker-Compose** provides an easy way to manage containers and streamline deployment workflows.

In this guide, we’ll explore setting up Nginx as a reverse proxy, configuring Docker-Compose for multiple services, enabling caching, and securing HTTP traffic with SSL.

---

## Section 1: What is Docker-Compose?  

**Docker-Compose** simplifies the management of multi-container applications. It allows you to define services, networks, and volumes in a single `docker-compose.yml` file.

Here's an example configuration:

```yaml
version: '3'
services:
  nginx: 
    image: nginx:latest
    container_name: reverse_proxy
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
    ports:
      - 80:80
      - 443:443

  web_app:
    image: your_app_image:latest
    container_name: web_app
    expose:
      - "80"
```

### Key Features:
- **Networks**: Connect containers securely.
- **Volumes**: Persist data across container restarts.
- **Environment Variables**: Simplify configurations for different environments.

---

## Section 2: Configuring Nginx as a Reverse Proxy  

Nginx acts as the central hub, routing incoming requests to appropriate backend services. Here's a sample Nginx configuration:

```nginx
http {
  server {
    server_name example.com;

    location /app1 {
      proxy_pass http://web_app:80;
      rewrite ^/app1(.*)$ $1 break;
    }

    location /app2 {
      proxy_pass http://another_service:5000;
      rewrite ^/app2(.*)$ $1 break;
    }
  }
}
```

### Explanation:
- **`proxy_pass`**: Routes requests to backend services.
- **`rewrite`**: Adjusts the request path for the target service.

---

## Section 3: Enabling Caching in Nginx  

Caching can significantly improve performance by storing responses for reuse. Add caching to your Nginx configuration as follows:

```nginx
http {
  proxy_cache_path /data/nginx/cache keys_zone=cache_zone:10m max_size=1g;

  server {
    proxy_cache cache_zone;
    proxy_cache_valid 200 1d;

    location / {
      proxy_pass http://web_app:80;
    }
  }
}
```

---

## Section 4: Securing HTTP Traffic with SSL  

SSL encrypts traffic between clients and your reverse proxy. Use **Certbot** to generate free certificates from Let’s Encrypt.

### Steps to Generate and Configure SSL Certificates:
1. **Install Certbot**:  
   ```bash
   sudo apt install certbot
   ```

2. **Generate Certificates**:  
   ```bash
   certbot --standalone -d example.com
   ```

3. **Update Nginx Configuration**:  
   ```nginx
   server {
     listen 443 ssl;
     ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

     location / {
       proxy_pass http://web_app:80;
     }
   }
   ```

4. **Automate Certificate Renewal**:  
   Add the following Cron job to automate renewals:  
   ```bash
   @daily certbot renew --pre-hook "docker-compose down" --post-hook "docker-compose up -d"
   ```

---

## Section 5: Bringing It All Together  

Below is the final `docker-compose.yml` and `nginx.conf` setup:

**docker-compose.yml**:  
```yaml
version: '3'
services:
  nginx:
    image: nginx:latest
    container_name: reverse_proxy
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - /etc/letsencrypt/:/etc/letsencrypt/
    ports:
      - 80:80
      - 443:443

  web_app:
    image: your_app_image:latest
    container_name: web_app
    expose:
      - "80"
```

**nginx.conf**:  
```nginx
http {
  server {
    listen 80;
    listen 443 ssl;
    server_name example.com;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
      proxy_pass http://web_app:80;
    }
  }
}
```

---

## Conclusion  

With **Nginx** and **Docker-Compose**, you can create a powerful reverse proxy setup that includes SSL encryption, caching, and seamless traffic management. While this guide provides a foundational setup, it’s recommended to fine-tune configurations for production environments.

By implementing these steps, you’ll enhance the security, scalability, and reliability of your applications.
