---
title: "K3s Pod DNS Not Resolving? Fix CoreDNS Forwarding"
date: 2024-05-18T19:26:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["k3s", "CoreDNS", "DNS", "Kubernetes"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Pods in K3s can't resolve a local or internal domain? Find out why CoreDNS forwards to 8.8.8.8, then fix it with resolv-conf or a coredns-custom ConfigMap."
more_link: "yes"
url: "/resolving-pod-dns-problems-in-k3s-with-coredns/"
quick_fix: |
  K3s ignores node resolvers that are loopback (`127.0.0.53` from systemd-resolved, a local dnsmasq), link-local or multicast. If it finds no usable one, CoreDNS forwards to `8.8.8.8`, which cannot see your internal zones.
  Fix it by pointing K3s at a real resolver file (`resolv-conf: /etc/k3s-resolv.conf` in `/etc/rancher/k3s/config.yaml`, then restart K3s),
  or forward just your internal domain with a `coredns-custom` ConfigMap in `kube-system` that has a `<name>.server` key.
---

A name resolves fine from your laptop and from the K3s node, but pods get `NXDOMAIN`. On K3s this almost always comes down to which upstream resolver CoreDNS forwards to. This guide walks through how to prove that and the two supported fixes.

<!--more-->

# Resolving Pod DNS Problems in K3s with CoreDNS

## The symptom

In this example an extra CoreDNS instance on the LAN serves `*.k3s.differentpla.net`, with LoadBalancer and Ingress names registered in it. Queries from outside the cluster work. Inside the cluster they fail: an Argo CD repository URL of `https://git.k3s.differentpla.net/USER/REPO.git` fails because the name does not resolve.

## Step 1: Test from a pod

Use the DNS test pod from the [Kubernetes DNS debugging guide](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/):

```bash
kubectl apply -f https://k8s.io/examples/admin/dns/dnsutils.yaml
kubectl exec -it dnsutils -- nslookup kubernetes.default
```

```
Server:		10.43.0.10
Address:	10.43.0.10#53

Name:	kubernetes.default.svc.cluster.local
Address: 10.43.0.1
```

Cluster DNS works. Now the internal name:

```bash
kubectl exec -it dnsutils -- nslookup git.k3s.differentpla.net
```

```
Server:		10.43.0.10
Address:	10.43.0.10#53

** server can't find git.k3s.differentpla.net: NXDOMAIN
```

## Step 2: Understand the DNS path

Pods use `dnsPolicy: ClusterFirst`, so their `/etc/resolv.conf` contains `nameserver 10.43.0.10`, the K3s CoreDNS Service. CoreDNS answers `cluster.local` names itself and sends everything else to the resolvers in **its own** `/etc/resolv.conf`.

CoreDNS runs with `dnsPolicy: Default`, so it inherits the resolver file that kubelet hands it:

```bash
kubectl -n kube-system get pod -l k8s-app=kube-dns -o jsonpath='{.items[0].spec.dnsPolicy}{"\n"}'
kubectl -n kube-system get cm coredns -o jsonpath='{.data.Corefile}' | grep -n forward
```

```
Default
    forward . /etc/resolv.conf
```

## Step 3: See which upstream CoreDNS really uses

The CoreDNS image has no shell, so you cannot simply `exec` into it. The easiest check is a throwaway pod with the same `dnsPolicy: Default`, which receives the same resolver file from kubelet:

```bash
kubectl run -i --restart=Never --rm test-${RANDOM} --image=busybox:1.36 \
  --overrides='{"apiVersion":"v1","spec":{"dnsPolicy":"Default"}}' -- cat /etc/resolv.conf
```

```
nameserver 8.8.8.8
```

That is the problem: CoreDNS forwards to Google Public DNS, which knows nothing about `k3s.differentpla.net`.

You can also confirm it with query logging. Add `log` to the Corefile (in K3s, prefer a `coredns-custom` key named `log.override` containing `log`, since K3s rewrites the main `coredns` ConfigMap), then read the logs:

```bash
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=20
```

```
[INFO] 10.42.0.179:43855 - 12121 "A IN git.k3s.differentpla.net.default.svc.cluster.local. udp 68 false 512" NXDOMAIN qr,aa,rd 161 0.000657711s
```

## Why K3s uses 8.8.8.8

Per the [K3s advanced options docs](https://docs.k3s.io/advanced), at startup each node checks `/etc/resolv.conf` and `/run/systemd/resolve/resolv.conf`. Nameservers that are **loopback, multicast or link-local** are treated as unusable, because pods cannot reach them. If neither file has a usable nameserver, K3s logs a warning and generates a stub resolver file with `8.8.8.8` and `2001:4860:4860::8888`.

Typical triggers:

- systemd-resolved with only the `127.0.0.53` stub and no real upstream in `/run/systemd/resolve/resolv.conf`.
- A local dnsmasq or Pi-hole on `127.0.0.1`.
- A node that got its DNS server by DHCP after K3s started.

Check the K3s logs on the node for the warning:

```bash
sudo journalctl -u k3s | grep -i resolv
```

## Fix 1: Give K3s a real resolver file

Create a resolver file that lists your LAN DNS server:

```bash
echo "nameserver 192.168.28.1" | sudo tee /etc/k3s-resolv.conf
```

Point K3s at it in `/etc/rancher/k3s/config.yaml` (on every node, servers and agents):

```yaml
resolv-conf: /etc/k3s-resolv.conf
```

Then restart K3s (`sudo systemctl restart k3s`, or `k3s-agent` on agents) and restart CoreDNS so it picks up the new file:

```bash
kubectl -n kube-system rollout restart deployment coredns
```

A file passed with `resolv-conf` (the `--resolv-conf` flag) skips the viability checks, so make sure the server in it is reachable from pods.

## Fix 2: Forward only your internal zone with coredns-custom

If you want public names to keep using the default path, forward just the internal domain. K3s's Corefile imports keys from a ConfigMap named `coredns-custom` in `kube-system`: keys ending in `.override` go inside the default `.:53` server block, and keys ending in `.server` become extra server blocks.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-custom
  namespace: kube-system
data:
  differentpla.server: |
    k3s.differentpla.net:53 {
        errors
        cache 30
        forward . 192.168.28.53
    }
```

```bash
kubectl apply -f coredns-custom.yaml
kubectl -n kube-system rollout restart deployment coredns
kubectl exec -it dnsutils -- nslookup git.k3s.differentpla.net
```

Use `coredns-custom` rather than editing the `coredns` ConfigMap: K3s manages that ConfigMap and overwrites manual changes on restart and upgrade.

## FAQ

### Why does `nslookup` on the node work but not in a pod?

The node may resolve through `127.0.0.53` (systemd-resolved), which forwards to your LAN DNS. Pods cannot use a loopback address on the node, so K3s replaced it with `8.8.8.8` for them.

### Do I need to restart pods after changing resolv-conf?

CoreDNS needs a restart to read the new file. Application pods with `ClusterFirst` do not, because their nameserver is still the CoreDNS Service.

### Does the same apply to RKE2?

RKE2 performs similar resolver checks and supports `resolv-conf` in `/etc/rancher/rke2/config.yaml`. Its CoreDNS is customized through a `HelmChartConfig` for `rke2-coredns` instead of `coredns-custom`; see [CoreDNS and NodeLocal DNSCache: Troubleshoot and Monitor](/coredns-nodelocaldns-troubleshooting-monitoring/).

## Related guides

- [How CoreDNS and NodeLocal DNSCache Work in Kubernetes](/post/kubernetes-coredns/)
- [CoreDNS and NodeLocal DNSCache: Troubleshoot and Monitor](/coredns-nodelocaldns-troubleshooting-monitoring/)
- [Running K3s in an IPv6-Only Environment with Cilium](/k3s-ipv6-cilium/)
