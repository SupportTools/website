---
title: "Kubernetes Ingress Hack: Managing Domain Names and TLS for External Applications"
date: 2025-05-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Ingress", "TLS", "External Services", "DevOps", "Cert-Manager"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to leverage Kubernetes Ingress controllers to provide domain names and automated TLS certificates for applications running outside your cluster."
more_link: "yes"
url: "/kubernetes-ingress-external-apps/"
---

Kubernetes excels at managing domains and TLS certificates for applications running inside the cluster, but what about your legacy applications, standalone Docker containers, or specialized hardware that lives outside Kubernetes? This practical guide demonstrates a clever technique to extend Kubernetes' powerful Ingress capabilities to any external application.

<!--more-->

# Extending Kubernetes Ingress to Non-Cluster Applications

## The Challenge: Managing External Application Access

While Kubernetes provides robust solutions for traffic routing, TLS certificate management, and domain configuration for workloads running inside the cluster, many organizations maintain a mix of infrastructure:

- Legacy applications not suitable for containerization
- Standalone services running on VMs or EC2 instances
- Specialized hardware with custom requirements
- Third-party services requiring secure access

Without a centralized approach, teams face several challenges:

1. Manual certificate management and renewal
2. Inconsistent domain configuration across environments
3. Complex DNS management
4. Higher security risks from expired certificates or misconfigurations
5. Operational overhead managing multiple ingress solutions

## The Solution: Kubernetes as a Smart Proxy

By leveraging Kubernetes' ability to define Services without selectors and manually specifying Endpoints, we can create a solution that:

- Uses Kubernetes Ingress for routing to external applications
- Leverages cert-manager for automatic TLS certificate provisioning
- Centralizes domain management in your existing Kubernetes tooling
- Requires zero modifications to the external applications

## Implementation in Three Simple Steps

### Step 1: Define a Service with Manual Endpoints

Unlike typical Kubernetes Services that automatically discover pods via selectors, we'll create a Service without selectors and manually define the Endpoints:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-app-service
  namespace: default
spec:
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: v1
kind: Endpoints
metadata:
  name: external-app-service
  namespace: default
subsets:
  - addresses:
      - ip: 10.240.0.129  # Your external application's IP address
    ports:
      - port: 8080        # The port your application listens on
```

This configuration tells Kubernetes where to find your external application and how to route traffic to it.

### Step 2: Set Up Automated TLS Certificate Management

Leverage cert-manager to automatically obtain and renew certificates from Let's Encrypt:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: external-app-cert
  namespace: default
spec:
  secretName: external-app-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - external-app.yourdomain.com
```

This assumes you've already [installed cert-manager](https://cert-manager.io/docs/installation/) and configured a ClusterIssuer for Let's Encrypt.

### Step 3: Configure the Ingress Resource

Finally, create an Ingress resource to route traffic from your domain to the external service:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: external-app-ingress
  namespace: default
  annotations:
    kubernetes.io/ingress.class: "nginx"  # Use your Ingress controller class
spec:
  tls:
    - hosts:
        - external-app.yourdomain.com
      secretName: external-app-tls
  rules:
    - host: external-app.yourdomain.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: external-app-service
                port:
                  number: 80
```

## How It Works: The Technical Details

This solution creates a seamless bridge between Kubernetes and your external applications:

1. **Traffic Flow**: External requests hit your Kubernetes Ingress controller
2. **TLS Termination**: The Ingress controller handles TLS termination using the certificate from cert-manager
3. **Routing**: Traffic is forwarded to the Service, which has no pod selectors
4. **Service to Endpoint**: Since there are no matching pods, Kubernetes uses the manually defined Endpoints
5. **Final Delivery**: Traffic reaches your external application with the correct host headers and paths

## Advantages of This Approach

Centralizing your ingress through Kubernetes provides several key benefits:

1. **Unified Certificate Management**: All TLS certificates managed in one place
2. **Automatic Renewal**: No more expired certificate emergencies
3. **Consistent Configuration**: Same Ingress patterns for all applications
4. **Easy Migration Path**: Simplifies eventual migration to containerized workloads
5. **Existing Tooling**: Leverage familiar Kubernetes tools and monitoring
6. **Security Standardization**: Consistent TLS configurations across all services

## Practical Use Cases

This technique proves valuable in numerous real-world scenarios:

### Legacy Application Integration
Connect mission-critical legacy applications to your modern infrastructure without modification.

### Hybrid Cloud Management
Maintain consistent access patterns across on-premises and cloud resources.

### Hardware Appliance Access
Provide secure access to specialized hardware devices through your standard Kubernetes gateway.

### Development Environments
Create consistent access to development tools that may run outside the cluster.

### Third-Party Service Integration
Provide a unified interface for accessing both internal and external services.

## Implementation Considerations

While this approach is powerful, keep these factors in mind:

- **Network Connectivity**: Ensure your Kubernetes nodes can reach the external application IP
- **Health Checks**: Consider implementing custom health checks for the external service
- **Security**: Remember the traffic between Kubernetes and the external application is unencrypted unless you configure additional TLS
- **IP Changes**: If your external application's IP changes, you'll need to update the Endpoints resource

## Conclusion

This Kubernetes ingress hack for external applications demonstrates the flexibility of Kubernetes as a platform. By treating Kubernetes as a smart proxy with automated certificate management, you can significantly simplify your overall architecture while maintaining robust security practices.

Whether you're managing a hybrid infrastructure, transitioning to containers, or simply need to maintain legacy systems alongside modern applications, this approach provides a practical solution that leverages your existing Kubernetes investment.

For complex environments, consider implementing this pattern with Helm charts or GitOps workflows to ensure consistent configuration and easy management across multiple external applications and environments.
