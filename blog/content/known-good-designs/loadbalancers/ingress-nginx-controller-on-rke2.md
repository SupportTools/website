---
title: "Ingress NGINX Controller on RKE2"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Load Balancers", "Ingress NGINX", "RKE2", "Kubernetes"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Overview of the built-in Ingress NGINX Controller on RKE2 and its differences from standalone deployments."
more_link: "yes"
url: "/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/"
---

![NGINX Architecture for RKE2](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-rke2/arch_nginx-for_rke2.png)

This is the known good design for leveraging the built-in Ingress NGINX Controller on RKE2.

<!--more-->

# [Overview](#overview)

## [Ingress NGINX on RKE2](#ingress-nginx-on-rke2)
RKE2 comes with the Ingress NGINX Controller enabled by default as part of its bundled networking stack. This eliminates the need to manually install or manage the Ingress NGINX Controller, providing seamless integration with the RKE2 ecosystem.

### Key Features
- **Preconfigured and Managed**: RKE2 automatically deploys and manages the lifecycle of the Ingress NGINX Controller.
- **Cluster-Aware Configuration**: Default values are tailored to the cluster’s networking setup (e.g., CIDRs, DNS settings).
- **Integrated with HelmChart CRD**: Managed using the `HelmChart` custom resource, which simplifies upgrades and configuration changes.
- **Built-in Default IngressClass**: Configured as the system default ingress class (`ingress-nginx`).

For more details, refer to the [RKE2 Networking Documentation](https://docs.rke2.io/networking/networking_services?_highlight=ingress#nginx-ingress-controller).

---

![Design of NGINX Ingress Controller on RKE2](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-rke2/design-of-NGINX-Ingress-Controller-on-RKE2.png)

---

## [How RKE2 Manages Ingress NGINX](#how-rke2-manages-ingress-nginx)

### HelmChart Custom Resource
RKE2 uses a `HelmChart` custom resource in the `kube-system` namespace to manage the Ingress NGINX Controller. This ensures the controller is automatically deployed and kept up-to-date.

#### Example HelmChart Resource
```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: rke2-ingress-nginx
  namespace: kube-system
spec:
  chartContent: ....
  set:
    global.clusterCIDR: 10.42.0.0/16
    global.clusterDNS: 10.43.0.10
    global.systemDefaultIngressClass: ingress-nginx
```

### Preconfigured Values
RKE2 configures Ingress NGINX with cluster-specific values, including:
- `global.clusterCIDR`: The cluster’s pod CIDR range.
- `global.serviceCIDR`: The service CIDR range.
- `global.clusterDomain`: The cluster domain (e.g., `cluster.local`).
- `global.systemDefaultIngressClass`: Set to `ingress-nginx` by default.

---

## [Differences from Standalone Deployments](#differences-from-standalone-deployments)

1. **Integrated Management**:
   - RKE2 handles the lifecycle of the Ingress NGINX Controller via the `HelmChart` CRD.
   - Users do not need to manually install or upgrade the controller.

2. **Preconfigured Defaults**:
   - RKE2 provides cluster-aware defaults, reducing the need for custom configuration.
   - These defaults include networking settings like CIDRs and DNS addresses.

3. **IngressClass Configuration**:
   - The `ingress-nginx` class is set as the default ingress class in RKE2.
   - This ensures that ingress resources without a specified class automatically use the Ingress NGINX Controller.

4. **Upgrades via RKE2 Release Cycle**:
   - Ingress NGINX is upgraded alongside RKE2 releases, ensuring compatibility and stability.

---

## [Customizing Ingress NGINX on RKE2](#customizing-ingress-nginx-on-rke2)

While RKE2 provides sensible defaults, users can customize the Ingress NGINX Controller by editing the `HelmChart` resource:

### Example Customization
1. **Retrieve the Current Configuration:**
   ```bash
   kubectl -n kube-system get helmchart rke2-ingress-nginx -o yaml
   ```

2. **Edit the HelmChart:**
   ```bash
   kubectl -n kube-system edit helmchart rke2-ingress-nginx
   ```

3. **Apply Custom Values:**
   Modify the `set` section to include custom configurations. For example:
   ```yaml
   spec:
     set:
       controller.config.ssl-protocols: "TLSv1.2 TLSv1.3"
       controller.config.proxy-read-timeout: "600"
       controller.replicaCount: "3"
   ```

4. **Save and Apply Changes:**
   The changes will be applied automatically, and the Ingress NGINX Controller will update accordingly.

---

## [References](#references)
- [RKE2 Ingress NGINX GitHub Repository](https://github.com/rancher/rke2-charts/tree/main-source/packages/rke2-ingress-nginx)
- [RKE2 Networking Documentation](https://docs.rke2.io/networking/networking_services?_highlight=ingress#nginx-ingress-controller)
