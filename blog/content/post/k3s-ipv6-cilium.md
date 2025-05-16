---
title: "Running K3s in an IPv6-Only Environment with Cilium"
date: 2025-06-01T00:00:00-05:00
draft: false
tags: ["k3s", "ipv6", "cilium", "bgp", "self-hosting", "kubernetes networking"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to configuring a single-node K3s cluster using IPv6-only networking with Cilium, including BGP routing and LoadBalancer support."
more_link: "yes"
url: "/k3s-ipv6-cilium/"
---

Most guides for Kubernetes focus on IPv4 by default, but IPv6 is no longer a second-class citizen. In this post, I walk through configuring a **K3s cluster using only IPv6**, with **Cilium** as the CNI, and **BGP** to announce addresses to my router. This setup runs entirely on a public IPv6 prefix—no dual-stack, no IPv4 fallback.

<!--more-->

# [Running K3s in an IPv6-Only Environment with Cilium](#running-k3s-in-an-ipv6-only-environment-with-cilium)

## [Design Goals](#design-goals)

This setup runs K3s on a single node using **native IPv6 only**, internally and externally. Here's what I wanted to achieve:

- Avoid Docker’s inconsistent IPv6 behavior.
- Use **K3s** for its lightweight footprint and ease of use.
- Use **Cilium** for networking because of its solid IPv6 support, helpful community, and great documentation.
- Advertise IPv6 addresses via **BGP** directly to my router, removing any reliance on NAT.

## [Installing K3s with IPv6 CIDRs](#installing-k3s-with-ipv6-cidrs)

The default K3s install pulls in components like Traefik, Flannel, and ServiceLB. We're disabling all of that and letting Cilium handle networking and policy enforcement.

Here's the install command:

```bash
export INSTALL_K3S_VERSION=v1.29.3+k3s1
export INSTALL_K3S_EXEC="\
  --disable traefik \
  --disable servicelb \
  --disable-network-policy \
  --flannel-backend=none \
  --cluster-cidr=2a01:4f8:a0:1720::1:0/112 \
  --kube-controller-manager-arg=node-cidr-mask-size-ipv6=112 \
  --service-cidr=2a01:4f8:a0:1720::2:0/112"

curl -sfL https://get.k3s.io | sh -
```

### Notes:

- **Traefik** is disabled since I'm using Ingress-NGINX.
- **ServiceLB**, **NetworkPolicy**, and **Flannel** are all replaced by Cilium.
- `--cluster-cidr` and `--service-cidr` specify the IPv6 address ranges for Pods and Services respectively.

## [Installing Cilium with IPv6-Only Support](#installing-cilium-with-ipv6-only-support)

Once K3s is up, deploy Cilium using their CLI:

```bash
cilium install --helm-set \
bgpControlPlane.enabled=true,\
ipv4.enabled=false,\
ipv6.enabled=true,\
ipam.operator.clusterPoolIPv6PodCIDRList={2a01:4f8:a0:1720::1:0/112},\
routingMode=native,\
ipv6NativeRoutingCIDR=2a01:4f8:a0:1720::1:0/112,\
enableIPv6Masquerade=false,\
policyEnforcementMode=always \
--version 1.16.1
```

This configuration:

- Enables **BGP**.
- Disables **IPv4** entirely.
- Enables **native IPv6** routing.
- Sets **routingMode** to native to avoid encapsulation overhead (e.g., VXLAN).
- Turns off masquerading—**no NAT needed** with IPv6.
- Enables **strict policy enforcement**, blocking all traffic unless explicitly allowed.

> **Important:** If `policyEnforcementMode=always`, make sure you define baseline policies to allow DNS and egress. Otherwise, your cluster will be locked down hard.

## [Assigning a Router ID for BGP](#assigning-a-router-id-for-bgp)

Since there’s no IPv4 address on the node, BGP requires a **router ID** to function. You can annotate your node with a unique (fake) IPv4 address:

```bash
kubectl annotate node NODENAME cilium.io/bgp-virtual-router.CLUSTERASN="router-id=10.10.10.1"
```

This step is critical for BGP peering to work in an IPv6-only setup.

## [Setting Up Cilium BGP and LoadBalancer IP Pools](#setting-up-cilium-bgp-and-loadbalancer-ip-pools)

Now configure the IP pool and peering policy. These are the IPs used for `LoadBalancer` services—**not** for internal Pods or Services.

```yaml
---
apiVersion: "cilium.io/v2alpha1"
kind: CiliumLoadBalancerIPPool
metadata:
  name: ip-pool
spec:
  blocks:
    - cidr: "2a01:4f8:a0:1720::3:0/112"
---
apiVersion: cilium.io/v2alpha1
kind: CiliumBGPPeeringPolicy
metadata:
  name: bgp-peer
spec:
  nodeSelector:
    matchLabels:
      kubernetes.io/os: linux
  virtualRouters:
    - localASN: 64512
      neighbors:
        - peerASN: 64513
          peerAddress: 2001:db8::1/128
      serviceSelector:
        matchExpressions:
          - { key: somekey, operator: NotIn, values: ["never-used-value"] }
```

- `localASN` and `peerASN` are autonomous system numbers. Replace `64512` with your organization's ASN or a private ASN (e.g., 65535) if this is a lab environment. The `peerASN` should match the ASN of your upstream router or ISP.
- Use a **third IPv6 block** for `LoadBalancer` services—distinct from your Pod and Service CIDRs. Choose a block that is separate from your existing network ranges and follows IPv6 best practices (e.g., /112 or /120 for small deployments). For example:
  - Pods: `2a01:4f8:a0:1720::1:0/112`
  - Services: `2a01:4f8:a0:1720::2:0/112`
  - LoadBalancers: `2a01:4f8:a0:1720::3:0/112`

## [Allowing DNS and Egress via Network Policies](#allowing-dns-and-egress-via-network-policies)

If you enabled strict policy enforcement, add policies to allow DNS and egress:

```yaml
---
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: "allow-dns"
spec:
  description: "Allow DNS from all endpoints to kube-dns"
  endpointSelector:
    matchLabels:
      k8s:io.kubernetes.pod.namespace: kube-system
      k8s-app: kube-dns
  ingress:
    - fromEndpoints:
      - {}
      toPorts:
        - ports:
          - port: "53"
            protocol: UDP
---
apiVersion: "cilium.io/v2"
kind: CiliumClusterwideNetworkPolicy
metadata:
  name: "allow-egress"
spec:
  description: "Allow all egress traffic"
  endpointSelector: {}
  egress:
    - toEntities:
      - "all"
```

These ensure your cluster can resolve domains and access external services.

## [Troubleshooting Common Issues](#troubleshooting-common-issues)

Here are some common issues and their solutions when working with IPv6-only K3s and Cilium:

### 1. **Pods Cannot Communicate**
- **Check CIDR Allocation:** Ensure your pod CIDR (`--cluster-cidr`) is correctly set and doesn't overlap with other networks.
- **Verify Cilium Installation:** Confirm Cilium is properly installed with IPv6 support enabled.
- **Network Policies:** Ensure pods have the necessary policies to communicate with each other.
- **Cilium Status:** Run `cilium status` to verify Cilium is healthy and connected to all nodes.
- **Check Logs:** Inspect Cilium logs with `kubectl logs -n cilium -l k8s-app=cilium`.

### 2. **BGP Peering Not Established**
- **Router ID:** Verify the node has a unique router ID annotation.
- **ASN Configuration:** Ensure local and peer ASNs match your network's configuration.
- **BGP Status:** Run ` cilium bgp status` to check peering status and troubleshoot connectivity.
- **Check BGP Logs:** Use `journalctl -u cilium -b` to review BGP-related logs for errors.
- **Network Connectivity:** Ensure the node's IPv6 address is reachable from the BGP peer.

### 3. **DNS Resolution Fails**
- **CoreDNS Configuration:** Ensure CoreDNS is properly configured in the kube-system namespace.
- **Network Policies:** Check policies to ensure DNS traffic (UDP port 53) is allowed.
- **Check DNS Pods:** Verify CoreDNS pods are running and healthy with `kubectl get pods -n kube-system`.
- **Test DNS Manually:** Use `nslookup` or `dig` from a test pod to check DNS resolution.

### 4. **Egress Traffic Blocked**
- **Network Policies:** Verify egress policies allow traffic to external networks.
- **Masquerade:** Ensure IPv6 masquerade is disabled as required for native routing.
- **Check Cilium Policies:** Use `cilium policy get` to inspect active policies.
- **Test Egress:** Create a test pod with a curl command to verify external connectivity.

### 5. **Cilium Policies Not Enforcing**
- **Policy Mode:** Confirm `policyEnforcementMode` is set to `always`.
- **Baseline Policies:** Ensure minimum policies are in place to allow essential traffic.
- **Check Policy Status:** Use `cilium policy status` to verify enforcement.
- **Review Logs:** Inspect Cilium logs for policy enforcement errors.

### 6. **Node-to-Node Connectivity Issues**
- **Check BGP Peers:** Ensure BGP peering is established between all nodes.
- **Verify Cilium Mesh:** Use `cilium mesh status` to check connectivity across the cluster.
- **Check Node Annotations:** Ensure all nodes have the correct router ID annotations.

### 7. **External Services Unreachable**
- **LoadBalancer IPs:** Verify the Cilium LoadBalancer IP pool is correctly configured.
- **Service CIDR:** Ensure the service CIDR is properly set and not overlapping with other networks.
- **Check NAT Rules:** Ensure no unwanted NAT rules are interfering with traffic.

### 8. **Cilium Installation Issues**
- **K3s Configuration:** Ensure K3s was installed with the correct IPv6 CIDRs.
- **Cilium Helm Values:** Verify the Helm values used for Cilium installation are correct.
- **Check System Logs:** Review system logs with `journalctl -u cilium -b` for installation errors.

### 9. **IPv6 Address Allocation Problems**
- **Check CIDR Blocks:** Ensure CIDR blocks are properly sized and non-overlapping.
- **Verify Cilium IPAM:** Use `cilium ipam show` to check IP address allocation status.
- **Check Kernel Parameters:** Ensure IPv6 kernel parameters are correctly configured.

### 10. **Performance Issues**
- **Cilium BPF Program Size:** Check for BPF program size warnings with `cilium status`.
- **Kernel Version:** Ensure the kernel version supports IPv6 and has the latest Cilium fixes.
- **Network Interface Configuration:** Verify network interfaces are properly configured for IPv6.

## [Final Thoughts](#final-thoughts)

Running **K3s in an IPv6-only setup** isn't overly complicated, but it requires attention to detail—especially around BGP, CIDR allocations, and policy enforcement.

So far, this single-node cluster has been stable, performant, and low-maintenance. Going multi-node will require more routing logic and testing, but for now, this IPv6-native Kubernetes cluster is working beautifully.

Stay tuned for a follow-up when I expand this setup across multiple nodes.
