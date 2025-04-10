---
title: "Running RKE2 Ingress-NGINX with an External LoadBalancer"
date: 2025-04-10T00:00:00-05:00
draft: false
tags: ["RKE2", "Ingress", "LoadBalancer", "AWS", "MetalLB"]
categories:
- Kubernetes
- RKE2
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide for configuring RKE2 ingress-nginx behind a LoadBalancer on AWS, GCP, Azure, or MetalLB."
more_link: "yes"
url: "/rke2-ingress-nginx-external-lb/"
---

This article provides step-by-step guidance for configuring RKE2’s built-in `ingress-nginx` controller to run behind an external LoadBalancer. It supports environments like AWS, GCP, Azure, and MetalLB, and replaces the default hostNetwork + DaemonSet configuration with a Deployment and LoadBalancer service.

<!--more-->

# Running RKE2 Ingress-NGINX with an External LoadBalancer

## Section 1: Summary and Use Case

### Summary

By default, RKE2 deploys the ingress controller as a DaemonSet with host networking. This is ideal for bare-metal setups but not suitable for cloud-native ingress via a LoadBalancer. This guide helps configure the controller to run as a Deployment with a LoadBalancer service, suitable for environments like AWS ELB or MetalLB.

### Use Case

You may want to:
- Integrate ingress-nginx with your cloud provider's LoadBalancer
- Use MetalLB for bare-metal LoadBalancer IP assignment
- Disable host networking for better isolation
- Scale ingress-nginx using Deployments

---

## Section 2: Configuration Instructions

### Prerequisites

- A running RKE2 cluster
- Access to the control plane node(s)
- A LoadBalancer integration (e.g., AWS, GCP, Azure, or MetalLB)

---

### Step 1: Create a HelmChartConfig Override

Create the following file on all RKE2 server nodes:

```bash
cat > /var/lib/rancher/rke2/server/manifests/ingress-nginx.yaml << 'EOF'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-ingress-nginx
  namespace: kube-system
spec:
  valuesContent: |
    controller:
      hostNetwork: false
      kind: Deployment
      replicaCount: 3
      service:
        enabled: true
        type: LoadBalancer
EOF
```

This config:
- Converts the controller to a Deployment
- Disables host networking
- Enables a LoadBalancer-type service

---

### Step 2: Wait for RKE2 to Apply Changes

RKE2 automatically reconciles manifests from this directory. To confirm deployment:

```bash
kubectl -n kube-system get deploy,svc -l app.kubernetes.io/name=ingress-nginx
```

You should see a Deployment and a LoadBalancer service.

---

### Step 3: Verification

Check that a LoadBalancer was successfully provisioned:

```bash
kubectl get svc -n kube-system ingress-nginx-controller
```

#### Example Output (AWS):

```
NAME                     TYPE           CLUSTER-IP       EXTERNAL-IP                                                               PORT(S)                      AGE
ingress-nginx-controller LoadBalancer   10.43.248.207    a1b2c3d4e5f6g7h8-1234567890.us-west-2.elb.amazonaws.com   80:31014/TCP,443:32478/TCP   2m
```

You can now route ingress traffic to the ELB hostname or associate a custom domain.

---

### Step 4: Example Ingress Resource

Here is a simple Ingress manifest for testing:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: example.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: your-service
            port:
              number: 80
```

Point the DNS for `example.yourdomain.com` to the ELB address or external IP.

---

### Notes

- Adjust `replicaCount` as needed
- Ensure firewall/security groups allow ports 80/443
- For MetalLB, ensure address pools are properly configured
- This override is persistent across cluster upgrades

---

### References

- RKE2 Docs: https://docs.rke2.io
- Kubernetes Ingress: https://kubernetes.io/docs/concepts/services-networking/ingress/
- MetalLB Setup: https://metallb.universe.tf/
