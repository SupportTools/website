---
title: "Enabling ModSecurity in the Kubernetes Ingress-NGINX Controller"
date: 2024-10-16T01:00:00-05:00
draft: false
tags: ["ModSecurity", "Ingress-NGINX", "Kubernetes"]
categories:
- Kubernetes
- Ingress
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide to enabling and configuring ModSecurity in the Kubernetes Ingress-NGINX controller."
more_link: "yes"
url: "/modsecurity-kubernetes-ingress-nginx/"
---

## Enabling ModSecurity in the Kubernetes Ingress-NGINX Controller

The Kubernetes Ingress-NGINX controller allows you to enable **ModSecurity**, a powerful open-source Web Application Firewall (WAF). This post will guide you through the process of enabling and configuring ModSecurity with Ingress-NGINX to protect your applications from various types of web attacks.

<!--more-->

### What is ModSecurity?

**ModSecurity** is a web application firewall designed to protect your applications from a range of web-based threats. With Ingress-NGINX, you can configure ModSecurity in multiple ways to meet your security needs.

There are three primary configurations for ModSecurity within Ingress-NGINX:

1. **Default Configuration** (Detection Only)
2. **OWASP Core Rule Set (CRS)**
3. **Custom Snippet**

Let’s walk through these configurations.

### Default Configuration

When ModSecurity is enabled without any additional rules or custom configurations, it runs in **Detection Only Mode**. This non-disruptive mode allows you to monitor traffic without affecting the behavior of your applications. It's recommended to run in this mode initially, analyze the generated logs, and fine-tune the rules accordingly.

By default, ModSecurity comes with basic rules, which you can modify to suit your application needs.

### OWASP Core Rule Set (CRS)

The **OWASP Core Rule Set (CRS)** is a set of widely used generic security rules designed to protect against the OWASP Top 10 vulnerabilities, such as:

- **SQL Injection (SQLi)**
- **Cross-Site Scripting (XSS)**
- **Local File Inclusion (LFI)**
- **Remote File Inclusion (RFI)**
- **Remote Code Execution (RCE)**
- **Session Fixation**
- **Scanner Detection**
- **Metadata/Error Leakages**

The CRS is highly documented and customizable, making it a robust solution for general-purpose web application security.

### Custom Snippet

A **ModSecurity Snippet** allows you to define custom security rules and directives tailored to your application. You can either create all custom rules within the snippet (though this can become challenging to maintain) or build a custom Ingress-NGINX image with pre-configured ModSecurity settings.

For complex setups, building a custom image is often the best approach. However, this tutorial will focus on using snippets for easier integration.

### Setting Up ModSecurity with Ingress-NGINX

Before diving into the ModSecurity configuration, ensure that your **Ingress-NGINX controller** is properly set up. If you already have it running on your Kubernetes cluster, you can skip the setup step. Otherwise, refer to the official documentation to deploy the Ingress-NGINX controller.

### Deploying an Application with ModSecurity Enabled

1. **Create a Deployment**

   First, let's deploy an application to test the ModSecurity configuration. In this example, we’ll deploy a simple echo server.

   ```bash
   echo "
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
           image: gcr.io/kubernetes-e2e-test-images/echoserver:2.1
           ports:
           - containerPort: 8080
   " | kubectl apply -f -
   ```

   Verify the deployment:

   ```bash
   kubectl get deploy
   kubectl get pods
   ```

2. **Expose the Application**

   Next, expose the deployment via a Kubernetes **Service**:

   ```bash
   echo "
   apiVersion: v1
   kind: Service
   metadata:
     name: meow-svc
   spec:
     ports:
     - port: 80
       targetPort: 8080
       protocol: TCP
     selector:
       app: meow
   " | kubectl apply -f -
   ```

   Verify the service is created:

   ```bash
   kubectl get svc
   ```

3. **Create an Ingress Rule with ModSecurity Enabled**

   Now, create an Ingress resource to route traffic to your application and enable ModSecurity with a custom snippet:

   ```bash
   echo "
   apiVersion: networking.k8s.io/v1
   kind: Ingress
   metadata:
     annotations:
       nginx.ingress.kubernetes.io/enable-modsecurity: 'true'
       nginx.ingress.kubernetes.io/modsecurity-snippet: |
         SecRuleEngine On
         SecRequestBodyAccess On
         SecAuditEngine RelevantOnly
         SecAuditLogParts ABIJDEFHZ
         SecAuditLog /var/log/modsec_audit.log
         SecRule REQUEST_HEADERS:User-Agent 'bad-scanner' 'log,deny,status:403,msg:\'Scanner Detected\''
     name: meow-ingress
   spec:
     rules:
     - http:
         paths:
         - path: /meow
           pathType: Prefix
           backend:
             service:
               name: meow-svc
               port:
                 number: 80
   " | kubectl apply -f -
   ```

   Verify the Ingress resource:

   ```bash
   kubectl get ing
   ```

### Testing the ModSecurity Setup

With ModSecurity enabled, you can now test the firewall's effectiveness.

1. **Send a Normal Request**

   Get the Minikube IP and test a normal request to the application:

   ```bash
   minikube ip
   curl https://<minikube-ip>/meow -k
   ```

2. **Send a Request with a Forbidden User-Agent**

   Now, test with a User-Agent string that triggers the custom ModSecurity rule:

   ```bash
   curl https://<minikube-ip>/meow -k -H "User-Agent: bad-scanner"
   ```

   You should receive a **403 Forbidden** response.

### Reviewing Logs

To view ModSecurity logs and verify that the firewall is working as expected, check the logs of the NGINX Ingress controller:

```bash
kubectl logs -n kube-system <nginx-ingress-controller-pod>
kubectl exec -it -n kube-system <nginx-ingress-controller-pod> cat /var/log/modsec_audit.log
```

### Troubleshooting

If ModSecurity doesn’t behave as expected or causes issues, examine the logs and NGINX configuration:

```bash
kubectl logs -n kube-system <nginx-ingress-controller-pod>
kubectl exec -it -n kube-system <nginx-ingress-controller-pod> cat /etc/nginx/nginx.conf
```
