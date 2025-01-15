---
title: "Understanding CoreDNS and NodeLocalDNS: Troubleshooting and Monitoring"
date: 2025-01-14T00:00:00-05:00
draft: true
tags: ["CoreDNS", "NodeLocalDNS", "Kubernetes", "DNS", "RKE2"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - [mmattox@support.tools](mailto:mmattox@support.tools)"
description: "Dive into CoreDNS and NodeLocalDNS, learn troubleshooting techniques, and monitor DNS effectively in Kubernetes clusters."
more_link: "yes"
url: "/coredns-nodelocaldns-troubleshooting-monitoring/"
---

DNS is the cornerstone of any Kubernetes cluster, enabling seamless communication between services. CoreDNS and NodeLocalDNS are key components in ensuring efficient DNS resolution. In this blog post, we explore what CoreDNS and NodeLocalDNS are, their role in RKE2 clusters, how to troubleshoot common issues, and techniques for effective monitoring.

### What is CoreDNS?
CoreDNS is a flexible, extensible DNS server that serves as the default DNS provider for Kubernetes clusters. It performs name resolution within the cluster and provides:

- Service discovery via DNS for Kubernetes services.
- DNS query forwarding for external domains.
- Plugin-based architecture for customization.

#### CoreDNS in RKE2
In RKE2, CoreDNS is deployed as a system Pod managed by the `rke2-coredns-addon`. It resides in the `kube-system` namespace and is integrated into the cluster's networking stack. RKE2 customizes CoreDNS through its ConfigMap, enabling features such as:

- Cluster-wide DNS forwarding.
- Integration with the cluster's service and pod network.
- Compatibility with RKE2-specific components like Canal or Calico.

### What is NodeLocalDNS?
NodeLocalDNS is an extension to CoreDNS that runs as a DaemonSet on Kubernetes nodes. It improves DNS query performance by caching responses locally on each node. Benefits include:

- Reduced DNS query latency.
- Improved cluster resilience by reducing CoreDNS load.
- Optimized DNS performance for high-scale clusters.

#### NodeLocalDNS in RKE2
In RKE2, NodeLocalDNS is optional but recommended for clusters with high DNS query volumes or latency-sensitive applications. When enabled:

- A dedicated IP is assigned for DNS caching on each node.
- It intercepts DNS queries from Pods and serves cached responses or forwards them to CoreDNS.
- The configuration is managed via the `nodelocaldns` Helm chart, part of the RKE2 addons.

To enable NodeLocalDNS in RKE2, configure the following:

1. Update the RKE2 config file (`/etc/rancher/rke2/config.yaml`) to include NodeLocalDNS settings.
2. Deploy the `nodelocaldns` Helm chart using RKE2's Helm controller.

---

### Troubleshooting CoreDNS and NodeLocalDNS

#### Common CoreDNS Issues and Fixes

**DNS Resolution Failures**

- **Symptoms**: Applications report "unknown host" or fail to resolve service names.
- **Checks**:
  - Ensure CoreDNS pods are running: `kubectl get pods -n kube-system -l k8s-app=kube-dns`.
  - Review CoreDNS logs: `kubectl logs -n kube-system -l k8s-app=kube-dns`.
  - Test resolution with `nslookup` or `dig`.
  - Test internal DNS: `kubectl run dns-test --rm -it --image=busybox --restart=Never -- nslookup <service-name>.<namespace>.svc.cluster.local`.
  - Test external DNS: `kubectl run dns-test --rm -it --image=busybox --restart=Never -- nslookup google.com`.
- **Fixes**:
  - Validate CoreDNS ConfigMap for syntax errors.
  - Ensure correct upstream servers are specified in the forward plugin.

**High Latency in DNS Queries**

- **Symptoms**: Applications experience delays in resolving hostnames.
- **Checks**:
  - Look for high CPU or memory usage in CoreDNS pods.
  - Monitor DNS query time with `kubectl exec` to test queries.
- **Fixes**:
  - Enable caching in the CoreDNS ConfigMap.
  - Scale CoreDNS replicas for better load distribution.

#### NodeLocalDNS Troubleshooting

**Local Cache Not Responding**

- **Symptoms**: DNS queries are slow, bypassing NodeLocalDNS.
- **Checks**:
  - Verify NodeLocalDNS DaemonSet is running: `kubectl get pods -n kube-system -l k8s-app=node-local-dns`.
  - Test DNS resolution directly via NodeLocalDNS IP using a pod: `kubectl run dns-test --rm -it --image=busybox --restart=Never -- nslookup kubernetes.default.svc.cluster.local <NodeLocalDNS-IP>`.
- **Fixes**:
  - Restart NodeLocalDNS pods to reset cache.
  - Verify node-level IP and configuration.

---

### Overlay Test

As part of Rancher's overlay test, which can be found [here](https://github.com/rancherlabs/support-tools), you can deploy it to the Rancher environment by running the following command:

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

The overlay test script includes the option to enable DNS checks using the `--dns-check` flag. Here's an example script:

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

### Monitoring CoreDNS and NodeLocalDNS

#### Using Metrics and Logs

**CoreDNS Metrics**

CoreDNS exports Prometheus metrics that provide insights into:

- DNS query rates (`coredns_dns_request_count_total`).
- Errors in query processing (`coredns_dns_request_error_count_total`).
- Cache hits and misses.

**NodeLocalDNS Metrics**

Monitor node-level metrics for latency and cache performance. In RKE2, metrics can be scraped from NodeLocalDNS DaemonSet pods by integrating Prometheus.

#### Visualization with Grafana

- **Dashboards**:
  - Import a Kubernetes DNS monitoring dashboard in Grafana (e.g., Dashboard ID: 14981).
  - Display metrics like query rates, error rates, and latency.

- **Alerting**:
  - Configure alerts for high error rates or unusual latency.

---

### Conclusion

CoreDNS and NodeLocalDNS are critical to Kubernetes cluster operations, especially in RKE2. Understanding their configurations, troubleshooting effectively, and setting up robust monitoring can ensure your cluster's DNS subsystem operates smoothly. By leveraging tools like Prometheus and Grafana, you can proactively address issues and optimize DNS performance.

