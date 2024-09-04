---
title: "How to Run NGINX for Root & Non-Root Users"  
date: 2024-10-10T19:26:00-05:00  
draft: false  
tags: ["NGINX", "Root", "Non-Root", "Linux", "Web Server"]  
categories:  
- NGINX  
- Linux  
- DevOps  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to configure NGINX to run both as root and non-root users, ensuring security and flexibility for your web server deployment."  
more_link: "yes"  
url: "/nginx-root-non-root/"  
---

Running **NGINX** as both a root and non-root user can be crucial depending on your deployment requirements. While root privileges allow full control over system resources, running NGINX as a non-root user enhances security by limiting the scope of potential vulnerabilities.

In this post, we will walk through the steps to run NGINX in both **root** and **non-root** configurations, allowing you to balance flexibility and security in your web server environment.

<!--more-->

### Why Run NGINX as Non-Root?

By default, NGINX runs as root, which allows it to bind to privileged ports (such as port 80 and 443) and manage system-level resources. However, running as root can expose your system to security risks if NGINX or a hosted web application is compromised.

Running NGINX as a **non-root** user mitigates these risks by limiting the permissions of the NGINX process, preventing access to sensitive system areas.

### Step 1: Running NGINX as Root

When running NGINX as root, it can bind to lower privileged ports such as **80** and **443**. This is the default behavior in most Linux distributions when NGINX is installed using a package manager.

To install and start NGINX as root on a Debian-based system:

```bash
sudo apt update
sudo apt install nginx
sudo systemctl start nginx
```

By default, the **nginx.conf** file is set to run NGINX with root privileges:

```nginx
user  root;
worker_processes  auto;
events {
    worker_connections  1024;
}
http {
    server {
        listen 80;
        server_name mysite.com;
        root /var/www/html;
    }
}
```

This configuration allows NGINX to bind to port 80 and serve web traffic as the root user.

#### Root User Caveats
While running NGINX as root provides access to privileged resources, it also exposes your system to greater security risks. A better practice is to run NGINX as a **non-root** user wherever possible.

### Step 2: Running NGINX as a Non-Root User

To run NGINX as a **non-root** user, you need to ensure the following:
1. **Use a non-privileged port** (e.g., port 8080) since non-root users cannot bind to ports below 1024.
2. Adjust file and directory permissions to allow the non-root user to read NGINX configuration files and serve content.

#### 1. Create a Non-Root User for NGINX
First, create a dedicated user for running NGINX:

```bash
sudo useradd -r -d /var/www/nginx -s /bin/false nginxuser
```

The `-r` flag creates a system account without a password, and `/bin/false` prevents the user from logging in.

#### 2. Update Permissions for Non-Root NGINX

Next, set the appropriate permissions on the NGINX directories:

```bash
sudo chown -R nginxuser:nginxuser /var/www/html
```

This ensures the **nginxuser** has the necessary read and write access to the web directory.

#### 3. Modify the NGINX Configuration
Update the NGINX configuration file to run as the **nginxuser** and use a non-privileged port:

```nginx
user  nginxuser;
worker_processes  auto;
events {
    worker_connections  1024;
}
http {
    server {
        listen 8080;
        server_name mysite.com;
        root /var/www/html;
    }
}
```

In this configuration:
- NGINX runs as `nginxuser`.
- NGINX binds to port **8080**, which does not require root privileges.

#### 4. Start NGINX as Non-Root

Finally, start NGINX using the new configuration. Since non-root users cannot run systemd services directly, use the **sudo** command to start NGINX:

```bash
sudo -u nginxuser nginx -c /etc/nginx/nginx.conf
```

This command starts NGINX as the `nginxuser` with the specified configuration file.

### Step 3: Running NGINX in Docker as Non-Root

When running NGINX in a Docker container, you may also want to avoid root privileges. Here’s how you can run NGINX as a non-root user in Docker.

#### Dockerfile Example for Non-Root NGINX

```dockerfile
FROM nginx:latest

# Create a non-root user
RUN useradd -r -d /var/www/html -s /bin/false nginxuser

# Set permissions
RUN chown -R nginxuser:nginxuser /var/www/html

# Switch to non-root user
USER nginxuser

# Expose a non-privileged port
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
```

In this Dockerfile:
- We create a **non-root user** (`nginxuser`).
- We change the ownership of the NGINX directory.
- We switch to the non-root user and expose port **8080**.

To build and run this Docker container:

```bash
docker build -t nginx-nonroot .
docker run -p 8080:8080 nginx-nonroot
```

### Conclusion

Running NGINX as both root and non-root users gives you flexibility in different environments. For development and testing environments, running NGINX as root may be convenient, but in production, running as a non-root user enhances security by limiting access to critical system resources.

By following the steps outlined in this post, you can easily configure NGINX to run with the necessary privileges for your use case—whether you need root access for privileged ports or a secure, non-root configuration for increased safety.

