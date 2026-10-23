---
title: "How CoreDNS and NodeLocal DNSCache Work in Kubernetes"
date: 2023-02-03T01:02:00-06:00
lastmod: 2026-10-23
draft: false
tags: ["Kubernetes", "DNS", "CoreDNS", "NodeLocalDNS", "network plugins", "pods", "services", "records"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "How a pod's DNS query reaches CoreDNS or NodeLocal DNSCache, how Service and external names resolve, the default Corefile, and how to test each hop."
more_link: "yes"
quick_fix: |
  A pod sends every query to the `nameserver` in its `/etc/resolv.conf`: the cluster DNS Service IP (CoreDNS), or with NodeLocal DNSCache a cache on the same node at `169.254.20.10`.
  CoreDNS answers `*.cluster.local` names from its in-memory view of Services and EndpointSlices, and forwards everything else to the upstream resolvers in the node's `/etc/resolv.conf`.
  NodeLocal DNSCache sits in front: it caches, sends cluster names to CoreDNS over TCP, and by default sends external names straight to the node's upstream resolvers.
  Test with `kubectl exec -it dnsutils -- nslookup kubernetes.default`.
---

DNS is how pods find Services and the outside world. This post explains the actual path a DNS query takes in a Kubernetes cluster, what CoreDNS and NodeLocal DNSCache each do, and how to verify every hop when something breaks.

<!--more-->

# DNS resolution in Kubernetes

Every pod gets a `/etc/resolv.conf` written by the kubelet. With the default `dnsPolicy: ClusterFirst` it looks like this:

```
search default.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.43.0.10
options ndots:5
```

- **`nameserver`**: the cluster DNS Service IP (`10.43.0.10` on RKE2 and K3s, `10.96.0.10` on many kubeadm clusters). Pods talk to CoreDNS through this Service.
- **`search`**: lets a pod use short names such as `nginx-svc` or `nginx-svc.prod`.
- **`ndots:5`**: any name with fewer than five dots is tried with each search domain first. That is why `api.example.com` can generate several queries before the real one. Use a trailing dot (`api.example.com.`) or lower `ndots` in the pod's `dnsConfig` for chatty external lookups.

## CoreDNS

CoreDNS is the default cluster DNS server. It runs as a Deployment in `kube-system` (pods labeled `k8s-app=kube-dns` for backward compatibility) behind the cluster DNS Service.

CoreDNS does **not** call the API server for each query. Its `kubernetes` plugin keeps a watch on Services, EndpointSlices and Namespaces and answers from that in-memory cache, which is why lookups are fast and why a brief API server outage does not immediately break DNS.

The kubeadm default Corefile shows the plugins involved:

```
.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30
    loop
    reload
    loadbalance
}
```

- **`kubernetes`** answers names in `cluster.local` and reverse lookups.
- **`forward`** sends everything else to the resolvers in the CoreDNS pod's `/etc/resolv.conf`, which comes from the node.
- **`cache`** caches answers for up to 30 seconds.
- **`prometheus`** exposes metrics on port 9153.

RKE2 and K3s ship a very similar Corefile, managed by their packaged charts.

### Records CoreDNS serves

| Name | Answer |
|---|---|
| `<service>.<namespace>.svc.cluster.local` | The Service ClusterIP (A or AAAA) |
| Same name, headless Service (`clusterIP: None`) | The IPs of the ready pods behind it |
| `<pod>.<service>.<namespace>.svc.cluster.local` | A specific pod of a headless Service (StatefulSets) |
| `_<port>._<proto>.<service>.<namespace>.svc.cluster.local` | SRV record for a named port |
| `<a-b-c-d>.<namespace>.pod.cluster.local` | A pod by IP, enabled by `pods insecure` |
| `<service>.<namespace>.svc.cluster.local` for `type: ExternalName` | A CNAME to the external name |

## NodeLocal DNSCache

NodeLocal DNSCache is not new: it has been stable since Kubernetes v1.18. It runs a small CoreDNS-based cache as a DaemonSet on every node, bound to a link-local address, `169.254.20.10` by default.

How it fits in:

1. In the common iptables mode, the cache also listens on the cluster DNS Service IP on each node and adds NOTRACK rules, so pods keep their normal `nameserver` and their queries never leave the node or touch conntrack.
2. In IPVS mode, or when you choose to, kubelet's `clusterDNS` is set to `169.254.20.10` and pods query the cache directly.
3. With Cilium kube-proxy replacement, iptables interception does not apply, so a Cilium Local Redirect Policy sends DNS traffic to the local cache instead.

What it does with a query:

- **Cache hit**: answers immediately from the node.
- **`cluster.local` names** (and reverse zones): forwards to CoreDNS, using TCP, through a separate Service (often named `kube-dns-upstream`).
- **Everything else**: by default forwards straight to the node's upstream resolvers from `/etc/resolv.conf`, not through CoreDNS.

Benefits: lower latency, far less load on CoreDNS, and no more 5 second timeouts from the Linux conntrack race on parallel UDP A and AAAA queries.

# Example: Service record resolution

A pod in namespace `default` looks up `nginx-svc`:

1. The resolver tries `nginx-svc.default.svc.cluster.local` first because of the search list.
2. The query goes to the `nameserver` (CoreDNS, or the node cache which forwards it to CoreDNS on a miss).
3. CoreDNS's `kubernetes` plugin finds the Service in its watch cache and returns the ClusterIP.
4. The pod connects to the ClusterIP, and kube-proxy or the CNI's eBPF datapath load balances to a backend pod.

# Example: External record resolution

A pod looks up `www.example.com`:

1. With `ndots:5`, the resolver first tries `www.example.com.default.svc.cluster.local`, `www.example.com.svc.cluster.local` and `www.example.com.cluster.local`, each returning NXDOMAIN, then the name itself.
2. **Without NodeLocal DNSCache**: CoreDNS checks its cache, and on a miss its `forward` plugin queries the upstream resolvers from the node's `/etc/resolv.conf` (or any stub domains you configured).
3. **With NodeLocal DNSCache**: the node cache answers from cache, or forwards to the node's upstream resolvers itself.
4. The answer is cached and returned to the pod.

# How to verify each hop

```bash
# Test pod from the Kubernetes docs
kubectl apply -f https://k8s.io/examples/admin/dns/dnsutils.yaml

# What resolver does the pod use?
kubectl exec -it dnsutils -- cat /etc/resolv.conf

# Cluster name and external name
kubectl exec -it dnsutils -- nslookup kubernetes.default
kubectl exec -it dnsutils -- nslookup www.example.com

# Ask a CoreDNS pod directly, bypassing the node cache
# (in NodeLocal iptables mode the Service IP itself is answered by the node cache)
COREDNS_POD_IP=$(kubectl -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].status.podIP}')
kubectl exec -it dnsutils -- nslookup kubernetes.default.svc.cluster.local "$COREDNS_POD_IP"

# Ask the node cache directly
kubectl exec -it dnsutils -- nslookup kubernetes.default.svc.cluster.local 169.254.20.10
```

If CoreDNS answers but the node cache does not, look at the NodeLocal DaemonSet and its redirect. If neither answers, check the CoreDNS pods and logs. Step by step fixes are in [CoreDNS and NodeLocal DNSCache: Troubleshoot and Monitor](/coredns-nodelocaldns-troubleshooting-monitoring/).

# FAQ

## Does NodeLocal DNSCache replace CoreDNS?

No. It is a cache in front of CoreDNS. CoreDNS still answers every cluster name that is not already cached.

## Do external lookups go through CoreDNS when NodeLocal DNSCache is enabled?

Not by default. The standard NodeLocal configuration forwards non-cluster names directly to the node's upstream resolvers.

## Why do pods make so many DNS queries for one name?

`ndots:5` plus three search domains means up to four lookups (times two for A and AAAA) for a name like `api.example.com`. Use fully qualified names with a trailing dot or tune `dnsConfig.options`.

# Related guides

- [CoreDNS and NodeLocal DNSCache: Troubleshoot and Monitor](/coredns-nodelocaldns-troubleshooting-monitoring/)
- [Resolving Pod DNS Problems in K3s with CoreDNS](/resolving-pod-dns-problems-in-k3s-with-coredns/)
- [Kubernetes DNS Optimization](/kubernetes-dns-optimization/)
- [CoreDNS with Rancher: Best Practices and Troubleshooting](/coredns-and-rancher/)
