---
title: "CoreDNS and NodeLocal DNSCache: Troubleshoot and Monitor"
date: 2025-01-14T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["CoreDNS", "NodeLocalDNS", "Kubernetes", "DNS", "RKE2"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Fix Kubernetes DNS failures and latency: test CoreDNS and NodeLocal DNSCache, enable NodeLocal on RKE2 with Canal or Cilium, and monitor the right metrics."
more_link: "yes"
url: "/coredns-nodelocaldns-troubleshooting-monitoring/"
quick_fix: |
  Start a test pod with `kubectl apply -f https://k8s.io/examples/admin/dns/dnsutils.yaml` and run
  `kubectl exec -it dnsutils -- nslookup kubernetes.default`. If that fails, check `kubectl -n kube-system get pods -l k8s-app=kube-dns` and their logs.
  With NodeLocal DNSCache, also query the node cache directly: `kubectl exec -it dnsutils -- nslookup kubernetes.default 169.254.20.10`.
  If CoreDNS works but the node cache does not, the cache pod or its redirect (iptables, or a Cilium Local Redirect Policy) is the problem.
---

DNS is the cornerstone of any Kubernetes cluster. CoreDNS answers cluster DNS queries, and NodeLocal DNSCache puts a caching resolver on every node in front of it. This guide explains how both work on RKE2, how to enable NodeLocal DNSCache with Canal or Cilium, how to troubleshoot failures and latency, and which Prometheus metrics to watch.

<!--more-->

### What is CoreDNS?
CoreDNS is a flexible, extensible DNS server and the default cluster DNS provider for Kubernetes. It provides:

- Service discovery via DNS for Kubernetes Services and Pods.
- Forwarding of external names to upstream resolvers.
- A plugin-based architecture for customization.

![CoreDNS](https://cdn.support.tools/posts/coredns/nodelocaldns.svg)

#### CoreDNS in RKE2
RKE2 installs CoreDNS from its packaged `rke2-coredns` Helm chart into `kube-system`, together with the cluster-proportional-autoscaler that scales CoreDNS replicas with cluster size. Pods keep the `k8s-app=kube-dns` label, the Deployment is `rke2-coredns-rke2-coredns`, and the Service is still named `kube-dns`. You change it with a `HelmChartConfig` named `rke2-coredns`, not by editing the ConfigMap, because the Helm controller reverts manual edits. Disable it with `disable: rke2-coredns` in `/etc/rancher/rke2/config.yaml` only if you deploy another cluster DNS.

Recent RKE2 releases (from the September 2026 releases, per the [RKE2 networking docs](https://docs.rke2.io/networking/networking_services)) also allow Corefile customization through the chart. The docs warn that only the default Corefile is tested, so keep changes small.

For deeper Corefile topics, see [CoreDNS with Rancher: Best Practices and Troubleshooting](/coredns-and-rancher/).

### What is NodeLocal DNSCache?
NodeLocal DNSCache (often called NodeLocalDNS) runs a small CoreDNS-based cache as a DaemonSet on every node, listening on a link-local address (`169.254.20.10` by default). Pods send queries to the local cache, which answers from cache or forwards cluster names to CoreDNS over TCP. Benefits:

- Lower DNS latency, since most answers come from the same node.
- Less load on the CoreDNS Deployment.
- Avoids conntrack races on UDP DNS that cause intermittent 5 second lookups.

#### NodeLocal DNSCache in RKE2
In RKE2, NodeLocal DNSCache is optional and is part of the `rke2-coredns` chart. Enable it with a `HelmChartConfig`, placed in `/var/lib/rancher/rke2/server/manifests/` on a server node or applied with `kubectl`.

**Canal or Calico with kube-proxy in iptables mode:**

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-coredns
  namespace: kube-system
spec:
  valuesContent: |-
    nodelocal:
      enabled: true
```

**kube-proxy in IPVS mode:** add `ipvs: true` under `nodelocal`. In IPVS mode the cache cannot intercept the Service IP, so every node's kubelet must point at the node-local address instead, for example `kubelet-arg: ["cluster-dns=169.254.20.10"]` in the RKE2 config, followed by an RKE2 restart and a restart of running pods. Note that kube-proxy IPVS mode is deprecated starting in Kubernetes v1.35.

**Cilium with kube-proxy replacement:** Cilium's eBPF datapath bypasses the iptables rules NodeLocal normally uses, so RKE2 uses a Cilium Local Redirect Policy instead (supported since v1.28.13+rke2r1, v1.29.8+rke2r1 and v1.30.4+rke2r1):

```yaml
---
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-cilium
  namespace: kube-system
spec:
  valuesContent: |-
    kubeProxyReplacement: true
    k8sServiceHost: <api-server-ip>
    k8sServicePort: 6443
    localRedirectPolicy: true
---
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-coredns
  namespace: kube-system
spec:
  valuesContent: |-
    nodelocal:
      enabled: true
      use_cilium_lrp: true
```

Set `k8sServiceHost` to an address that reaches the API server from every node (RKE2's docs use your API server IP). The RKE2 docs still show the older `localRedirectPolicy: true` key, while the current [Cilium docs](https://docs.cilium.io/en/stable/network/kubernetes/local-redirect-policy/) enable the feature with `localRedirectPolicies.enabled: true`. Whichever key your Cilium chart version accepts, confirm the result with `kubectl -n kube-system get cm cilium-config -o yaml | grep local-redirect`, which should show `enable-local-redirect-policy: "true"`. For Cilium side debugging, see the [Cilium Troubleshooting Guide](/post/cilium-troubleshooting-2025/).

Warning from the RKE2 docs: NodeLocal changes node iptables rules to intercept DNS, so enabling it and then disabling it without redeploying can break DNS until the rules are cleaned up.

---

### Troubleshooting CoreDNS and NodeLocal DNSCache

Create a test pod first. The upstream `dnsutils` manifest uses `registry.k8s.io/e2e-test-images/agnhost`, which has reliable `nslookup` and `dig` (BusyBox `nslookup` gives misleading results with search domains):

```bash
kubectl apply -f https://k8s.io/examples/admin/dns/dnsutils.yaml
kubectl wait --for=condition=Ready pod/dnsutils
kubectl exec -it dnsutils -- cat /etc/resolv.conf
```

The `nameserver` line tells you which path the pod uses: the CoreDNS Service IP, or `169.254.20.10` in IPVS-mode NodeLocal setups.

#### Common CoreDNS issues and fixes

**DNS resolution failures**

- **Symptoms**: applications report "unknown host" or `SERVFAIL`, or fail to resolve Service names.
- **Checks**:
  - CoreDNS pods are running: `kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide`.
  - CoreDNS logs: `kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50`.
  - The Service has endpoints: `kubectl get endpointslices -n kube-system -l k8s-app=kube-dns`.
  - Internal name: `kubectl exec -it dnsutils -- nslookup kubernetes.default`.
  - Service in another namespace: `kubectl exec -it dnsutils -- nslookup <service>.<namespace>.svc.cluster.local`.
  - External name: `kubectl exec -it dnsutils -- nslookup example.com`.
- **Fixes**:
  - Validate the Corefile for syntax errors; CoreDNS logs `plugin/...` errors at startup.
  - Make sure the `forward` plugin points at working upstream resolvers. By default it uses the node's `/etc/resolv.conf`. On hosts with systemd-resolved that file points at `127.0.0.53`, which is unreachable from inside a pod; RKE2 and K3s detect this and hand kubelet `/run/systemd/resolve/resolv.conf` instead, and on other distributions you set kubelet's `--resolv-conf` yourself.
  - If only pods on some nodes fail, test pod to pod connectivity across nodes (see the overlay test below); DNS is often the first symptom of a broken CNI overlay.
  - Turn on query logging temporarily by adding the `log` plugin to the Corefile.

**High latency in DNS queries**

- **Symptoms**: slow first requests, or lookups that take about 5 seconds and then succeed.
- **Checks**:
  - CPU throttling or OOM restarts in CoreDNS pods: `kubectl top pods -n kube-system -l k8s-app=kube-dns`.
  - Query time from a pod: `kubectl exec -it dnsutils -- dig +stats kubernetes.default.svc.cluster.local`.
  - The `ndots:5` search path: an external name like `api.example.com` is first tried with every search domain. A trailing dot (`api.example.com.`) or a lower `ndots` in the pod `dnsConfig` avoids that.
- **Fixes**:
  - Keep the `cache` plugin enabled (it is in the default Corefile) and give CoreDNS enough CPU.
  - Scale CoreDNS (adjust the autoscaler parameters in the `rke2-coredns` `HelmChartConfig`).
  - Enable NodeLocal DNSCache to remove cross-node hops and the UDP conntrack race.

More tuning ideas are in [Kubernetes DNS Optimization](/kubernetes-dns-optimization/).

#### NodeLocal DNSCache troubleshooting

**Local cache not responding**

- **Symptoms**: DNS is slow or fails on some nodes, or pods bypass the cache.
- **Checks**:
  - The DaemonSet is running on every node: `kubectl get ds -n kube-system | grep -i node-local` and `kubectl get pods -n kube-system -o wide | grep -i node-local`.
  - Query the cache directly from a pod on the affected node: `kubectl exec -it dnsutils -- nslookup kubernetes.default 169.254.20.10`.
  - In iptables mode, check on the node that the link-local address exists: `ip addr show nodelocaldns`.
  - With Cilium, confirm the redirect policy exists: `kubectl get ciliumlocalredirectpolicies -A`.
- **Fixes**:
  - Restart the NodeLocal pod on the affected node.
  - If you just toggled NodeLocal on or off, restart RKE2 on the node and recreate pods so iptables rules and `resolv.conf` match.
  - With Cilium, make sure `localRedirectPolicy` is enabled in `rke2-cilium` and the Cilium agents were restarted after the change.

---

### Overlay test

DNS failures on only some nodes usually mean pod to pod traffic between nodes is broken. Rancher's [support-tools overlay test](https://github.com/rancherlabs/support-tools) checks that. Deploy its DaemonSet:

```bash
kubectl apply -f https://raw.githubusercontent.com/rancherlabs/support-tools/master/swiss-army-knife/overlaytest.yaml
```

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: overlaytest
spec:
  selector:
      matchLabels:
        name: overlaytest
  template:
    metadata:
      labels:
        name: overlaytest
    spec:
      tolerations:
      - operator: Exists
      containers:
      - image: rancherlabs/swiss-army-knife
        imagePullPolicy: IfNotPresent
        name: overlaytest
        command: ["sh", "-c", "tail -f /dev/null"]
        terminationMessagePath: /dev/termination-log
```

This will deploy a DaemonSet that will run on all nodes in the cluster. These pods will be running `tail -f /dev/null`, which will do nothing but keep the pod running.

To run the overlay test script, execute the following command:

```bash
curl -sfL https://raw.githubusercontent.com/rancherlabs/support-tools/master/swiss-army-knife/overlaytest.sh | bash
```

The script below is a simplified version that adds optional DNS checks with a `--dns-check` flag:

```bash
#!/bin/bash

DNS_CHECK=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dns-check)
      DNS_CHECK=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "=> Start network overlay, DNS, and API test"

kubectl get pods -l name=overlaytest -o jsonpath='{range .items[*]}{@.metadata.name}{" "}{@.spec.nodeName}{" "}{@.status.podIP}{"\n"}{end}' | sort -k2 |
while read spod shost sip
do
  echo "Testing pod $spod on node $shost with IP $sip"

  # Overlay network test
  echo "  => Testing overlay network connectivity"
  kubectl get pods -l name=overlaytest -o jsonpath='{range .items[*]}{@.status.podIP}{" "}{@.spec.nodeName}{"\n"}{end}' | sort -k2 |
  while read tip thost
  do
    if [[ ! $shost == $thost ]]; then
      kubectl --request-timeout='10s' exec $spod -c overlaytest -- /bin/sh -c "ping -c2 $tip > /dev/null 2>&1"
      RC=$?
      if [ $RC -ne 0 ]; then
        echo "    FAIL: $spod on $shost cannot reach pod IP $tip on $thost"
      else
        echo "    PASS: $spod on $shost can reach pod IP $tip on $thost"
      fi
    fi
  done

  if $DNS_CHECK; then
    # Internal DNS test
    echo "  => Testing internal DNS"
    kubectl --request-timeout='10s' exec $spod -c overlaytest -- /bin/sh -c "nslookup kubernetes.default > /dev/null 2>&1"
    RC=$?
    if [ $RC -ne 0 ]; then
      echo "    FAIL: $spod cannot resolve internal DNS for 'kubernetes.default'"
    else
      echo "    PASS: $spod can resolve internal DNS for 'kubernetes.default'"
    fi

    # External DNS test
    echo "  => Testing external DNS"
    kubectl --request-timeout='10s' exec $spod -c overlaytest -- /bin/sh -c "nslookup rancher.com > /dev/null 2>&1"
    RC=$?
    if [ $RC -ne 0 ]; then
      echo "    FAIL: $spod cannot resolve external DNS for 'rancher.com'"
    else
      echo "    PASS: $spod can resolve external DNS for 'rancher.com'"
    fi
  else
    echo "  => DNS checks are skipped. Use --dns-check to enable."
  fi

done

echo "=> End network overlay, DNS, and API test"
```

This script allows for comprehensive testing of overlay network connectivity, internal DNS, and external DNS. The `--dns-check` flag enables DNS-specific tests, ensuring the cluster's DNS functionality is verified.

---

### Monitoring CoreDNS and NodeLocal DNSCache

#### CoreDNS metrics

CoreDNS exposes Prometheus metrics on port 9153 through the `prometheus` plugin. Many older guides use metric names that were removed in CoreDNS 1.7.0 (`coredns_dns_request_count_total`, `coredns_dns_request_error_count_total`). The current names are:

| Metric | What it tells you |
|---|---|
| `coredns_dns_requests_total` | Query rate, by server, zone, protocol and type |
| `coredns_dns_responses_total` | Responses by `rcode` (`NOERROR`, `NXDOMAIN`, `SERVFAIL`, `REFUSED`) |
| `coredns_dns_request_duration_seconds` | Latency histogram |
| `coredns_cache_hits_total` / `coredns_cache_misses_total` | Cache effectiveness |
| `coredns_proxy_request_duration_seconds`, `coredns_proxy_healthcheck_failures_total` | Upstream (forward plugin) latency and failed health checks; the older `coredns_forward_requests_total` family is deprecated |
| `coredns_panics_total` | Crashes inside plugins |

Useful queries:

```promql
# Queries per second
sum(rate(coredns_dns_requests_total[5m]))

# SERVFAIL ratio
sum(rate(coredns_dns_responses_total{rcode="SERVFAIL"}[5m]))
  / sum(rate(coredns_dns_responses_total[5m]))

# 99th percentile latency
histogram_quantile(0.99, sum by (le) (rate(coredns_dns_request_duration_seconds_bucket[5m])))

# Cache hit ratio
sum(rate(coredns_cache_hits_total[5m]))
  / (sum(rate(coredns_cache_hits_total[5m])) + sum(rate(coredns_cache_misses_total[5m])))
```

#### NodeLocal DNSCache metrics

The node cache is CoreDNS-based, so it exports the same `coredns_*` metric names. In the upstream NodeLocal DNSCache manifest the metrics listen on port 9253; check the DaemonSet's container ports and annotations in your cluster before adding a scrape job, and add a `job` or `instance` filter so node cache metrics are not mixed with the CoreDNS Deployment.

#### Visualization and alerting with Grafana

- Import dashboard **14981** ("CoreDNS", built for the metric names used by CoreDNS 1.7.0 and later). Dashboards made for the old names show empty panels.
- Alert on a sustained SERVFAIL ratio, on p99 latency above your target (for example 100 ms), and on CoreDNS pods not being ready.
- Rancher Monitoring (kube-prometheus-stack) already scrapes CoreDNS on RKE2 and ships CoreDNS alert rules; check them before adding your own.

---

### FAQ

#### What IP does NodeLocal DNSCache use?

`169.254.20.10` by default, set by `nodelocal.ip_address` in the RKE2 chart. In iptables mode the cache also intercepts traffic sent to the CoreDNS Service IP, so pods do not need a different `nameserver`. In IPVS mode you point kubelet at `169.254.20.10` instead.

#### Does NodeLocal DNSCache work with Cilium kube-proxy replacement?

Yes, but not through iptables. On RKE2 set `nodelocal.use_cilium_lrp: true` and enable Local Redirect Policies in Cilium, as shown above.

#### Why does DNS take 5 seconds and then work?

The usual causes are the UDP conntrack race on parallel A and AAAA queries, or a lost packet across a broken overlay. NodeLocal DNSCache fixes the first; the overlay test above finds the second.

#### Why do my CoreDNS Grafana panels show "No data"?

The dashboard uses metric names from before CoreDNS 1.7.0. Use `coredns_dns_requests_total` and `coredns_dns_responses_total`, or import dashboard 14981.

---

### Related guides

- [CoreDNS with Rancher: Best Practices and Troubleshooting](/coredns-and-rancher/)
- [Kubernetes DNS Optimization](/kubernetes-dns-optimization/)
- [Deploying an EKS Cluster with NodeLocal DNSCache](/post/deploy-eks-with-nodelocaldns/)
- [Cilium Troubleshooting Guide](/post/cilium-troubleshooting-2025/)
