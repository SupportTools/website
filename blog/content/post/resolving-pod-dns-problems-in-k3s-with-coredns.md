---
title: "Resolving Pod DNS Problems in k3s with CoreDNS"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["k3s", "CoreDNS", "DNS", "Kubernetes"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to resolve Pod DNS problems in k3s with CoreDNS, ensuring proper DNS resolution inside the cluster."
more_link: "yes"
url: "/resolving-pod-dns-problems-in-k3s-with-coredns/"
---

Learn how to resolve Pod DNS problems in k3s with CoreDNS, ensuring proper DNS resolution inside the cluster. This guide walks you through the debugging and resolution process.

<!--more-->

# [Resolving Pod DNS Problems in k3s with CoreDNS](#resolving-pod-dns-problems-in-k3s-with-coredns)

I’ve got an extra instance of CoreDNS running in my cluster, serving `*.k3s.differentpla.net`, with LoadBalancer and Ingress names registered in it. It’s working fine for queries to the cluster but not for queries inside the cluster. What’s up with that?

## [Motivation](#motivation)

While setting up an ArgoCD project, I set the Repository URL to `https://git.k3s.differentpla.net/USER/REPO.git`, but it failed, complaining that the name didn’t resolve. This was confusing since it works fine from outside the cluster.

## [Debugging DNS Resolution](#debugging-dns-resolution)

Refer to the [Kubernetes DNS debugging resolution guide](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/).

### Running a DNS Utils Pod

```bash
kubectl run dnsutils -it --restart=Never --rm --image=registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3 -- /bin/bash
```

DNS queries inside the pod:

```bash
nslookup kubernetes.default
```

Output:

```
Server:		10.43.0.10
Address:	10.43.0.10#53

Name:	kubernetes.default.svc.cluster.local
Address: 10.43.0.1
```

### Querying External DNS

```bash
nslookup git.k3s.differentpla.net
```

Output:

```
Server:		10.43.0.10
Address:	10.43.0.10#53

** server can't find git.k3s.differentpla.net: NXDOMAIN
```

## [Pod’s DNS Policy](#pods-dns-policy)

The default DNS policy for a pod is "ClusterFirst," which forwards queries to the upstream nameserver inherited from the node. However, the pod’s `/etc/resolv.conf` contains `nameserver 10.43.0.10`, which is the ClusterIP service for CoreDNS.

### CoreDNS DNS Policy

The DNS Policy for CoreDNS is "Default." Checking the configuration:

```bash
kubectl --namespace kube-system get pod coredns-96cc4f57d-cztp4 -o yaml | grep dnsPolicy
```

Output:

```
dnsPolicy: Default
```

### Inspecting CoreDNS ConfigMap

```bash
kubectl --namespace kube-system get cm coredns -o yaml
```

Excerpt from `Corefile`:

```yaml
...
forward . /etc/resolv.conf
```

### Inspecting /etc/resolv.conf in CoreDNS Pod

The CoreDNS container lacks a shell, complicating direct inspection:

```bash
kubectl --namespace kube-system exec -it coredns-96cc4f57d-cztp4 -- /bin/sh
```

Instead, use an ephemeral debug container (not enabled by default in k3s):

```bash
kubectl --namespace kube-system debug -it coredns-96cc4f57d-cztp4 --image=busybox
```

## [CoreDNS Logging](#coredns-logging)

Enable CoreDNS logging:

```bash
kubectl --namespace kube-system edit cm coredns
```

Add `log` to the `Corefile`:

```yaml
  Corefile: |
    .:53 {
        log
        errors
        health
        ...
    }
```

### Inspecting Logs

```bash
kubectl --namespace kube-system logs coredns-96cc4f57d-cztp4
```

Example log output:

```
[INFO] 127.0.0.1:55248 - 51746 "HINFO IN 7620827858334401234.2272423027405113866. udp 57 false 512" NXDOMAIN qr,rd,ra 132 0.012383467s
[INFO] 10.42.0.179:43855 - 12121 "A IN git.k3s.differentpla.net.default.svc.cluster.local. udp 68 false 512" NXDOMAIN qr,aa,rd 161 0.000657711s
```

## [Container Filesystem](#container-filesystem)

Inspect the container filesystem on the relevant node:

```bash
sudo ctr c ls | grep coredns
sudo cat /var/lib/rancher/k3s/agent/containerd/io.containerd.grpc.v1.cri/sandboxes/304b.../resolv.conf
```

Output:

```
nameserver 8.8.8.8
```

## [Rancher: Troubleshooting DNS](#rancher-troubleshooting-dns)

The Rancher docs have a [Troubleshooting DNS](https://rancher.com/docs/k3s/latest/en/advanced/#troubleshooting-dns) page. Check upstream nameservers:

```bash
kubectl run -i --restart=Never --rm test-${RANDOM} --image=ubuntu --overrides='{"kind":"Pod", "apiVersion":"v1", "spec": {"dnsPolicy":"Default"}}' -- sh -c 'cat /etc/resolv.conf'
```

Output:

```
nameserver 8.8.8.8
pod "test-19198" deleted
```

## [Understanding the Issue](#understanding-the-issue)

CoreDNS, as default-configured by k3s, uses Google’s DNS servers (`8.8.8.8`) instead of locally-configured DNS servers. This causes the DNS lookup issues for `*.k3s.differentpla.net`.

## [Using a Custom Override](#using-a-custom-override)

CoreDNS supports importing custom zones by placing files in the `/etc/coredns/custom` directory. This can be explored further to resolve the issue.

By following these steps, you can troubleshoot and resolve Pod DNS problems in k3s with CoreDNS, ensuring proper DNS resolution inside the cluster.
