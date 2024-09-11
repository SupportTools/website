---
title: "Using CoreDNS for LoadBalancer Addresses in Kubernetes"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["CoreDNS", "Kubernetes", "LoadBalancer"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to use CoreDNS for LoadBalancer addresses in Kubernetes, ensuring seamless access to your services."
more_link: "yes"
url: "/using-coredns-for-loadbalancer-addresses-in-kubernetes/"
---

Learn how to use CoreDNS for LoadBalancer addresses in Kubernetes, ensuring seamless access to your services. This guide provides a detailed setup process.

<!--more-->

# [Using CoreDNS for LoadBalancer Addresses in Kubernetes](#using-coredns-for-loadbalancer-addresses-in-kubernetes)

I’d like to access my load-balanced services by name (e.g., `docker.k3s.differentpla.net`) from outside my k3s cluster. Using `--addn-hosts` on `dnsmasq` on my router is fragile. Each time I add a load-balanced service, I must edit the additional hosts file and restart `dnsmasq`.

## [Setting Up CoreDNS](#setting-up-coredns)

Instead of editing the router frequently, I'll forward the `k3s.differentpla.net` subdomain to another DNS server using the `--server` option in `dnsmasq`. Kubernetes already provides CoreDNS for service discovery, so I'll use another instance of CoreDNS.

### [Creating the Deployment](#creating-the-deployment)

Here is the `deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: k3s-dns
  name: k3s-dns
  namespace: k3s-dns
spec:
  progressDeadlineSeconds: 600
  replicas: 1
  selector:
    matchLabels:
      app: k3s-dns
  template:
    metadata:
      labels:
        app: k3s-dns
    spec:
      containers:
      - args:
        - -conf
        - /etc/coredns/Corefile
        image: rancher/coredns-coredns:1.8.3
        imagePullPolicy: IfNotPresent
        livenessProbe:
          failureThreshold: 3
          httpGet:
            path: /health
            port: 8080
            scheme: HTTP
          initialDelaySeconds: 60
          periodSeconds: 10
          successThreshold: 1
          timeoutSeconds: 1
        name: coredns
        ports:
        - containerPort: 53
          name: dns
          protocol: UDP
        - containerPort: 53
          name: dns-tcp
          protocol: TCP
        - containerPort: 9153
          name: metrics
          protocol: TCP
        readinessProbe:
          failureThreshold: 3
          httpGet:
            path: /ready
            port: 8181
            scheme: HTTP
          periodSeconds: 2
          successThreshold: 1
          timeoutSeconds: 1
        resources:
          limits:
            memory: 170Mi
          requests:
            cpu: 100m
            memory: 70Mi
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            add:
            - NET_BIND_SERVICE
            drop:
            - all
          readOnlyRootFilesystem: true
        volumeMounts:
        - mountPath: /etc/coredns
          name: config-volume
          readOnly: true
      dnsPolicy: Default
      restartPolicy: Always
      schedulerName: default-scheduler
      securityContext: {}
      terminationGracePeriodSeconds: 30
      volumes:
      - name: config-volume
        configMap:
          name: k3s-dns
          items:
          - key: Corefile
            path: Corefile
          - key: NodeHosts
            path: NodeHosts
          defaultMode: 420
```

This deployment is a trimmed copy of the original CoreDNS deployment with modified names and additional probes and limits.

### [Creating the ConfigMap](#creating-the-configmap)

The deployment mounts a ConfigMap as a volume. Here is the `configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: k3s-dns
  namespace: k3s-dns
data:
  Corefile: |
    k3s.differentpla.net:53 {
        errors
        health
        ready
        hosts /etc/coredns/NodeHosts {
          ttl 60
          reload 15s
          fallthrough
        }
        cache 30
        loop
        reload
        loadbalance
    }
  NodeHosts: |
    192.168.28.11 nginx.k3s.differentpla.net
    192.168.28.12 docker.k3s.differentpla.net
```

### [Creating the Service](#creating-the-service)

Here is the `svc.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: k3s-dns
  name: k3s-dns
  namespace: k3s-dns
spec:
  type: NodePort
  ports:
  - port: 53
    name: dns-tcp
    protocol: TCP
    targetPort: 53
    nodePort: 32053
  - port: 53
    name: dns
    protocol: UDP
    targetPort: 53
    nodePort: 32053
  selector:
    app: k3s-dns
```

It's a NodePort service to be accessible from the router (i.e., outside the cluster).

### [Deploying and Verifying](#deploying-and-verifying)

Deploy the resources and verify:

```bash
kubectl apply -f deployment.yaml -f configmap.yaml -f svc.yaml
kubectl --namespace k3s-dns get all
```

Example output:

```
NAME                          READY   STATUS    RESTARTS   AGE
pod/k3s-dns-d6769ccc5-sj5gr   1/1     Running   0          6m9s

NAME              TYPE       CLUSTER-IP     EXTERNAL-IP   PORT(S)                     AGE
service/k3s-dns   NodePort   10.43.180.89   <none>        53:32053/TCP,53:32053/UDP   33m

NAME                      READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/k3s-dns   1/1     1            1           6m9s

NAME                                DESIRED   CURRENT   READY   AGE
replicaset.apps/k3s-dns-d6769ccc5   1         1         1       6m9s
```

Test the DNS:

```bash
dig +short -p 32053 @rpi401 nginx.k3s.differentpla.net
192.168.28.11
```

### [Router Configuration](#router-configuration)

Configure the router to forward DNS requests:

```bash
cat /etc/dhcpd/dhcpd-k3s-dns.conf
server=/k3s.differentpla.net/192.168.28.181#32053

cat /etc/dhcpd/dhcpd-k3s-dns.info
enable="yes"

sudo /etc/rc.network nat-restart-dhcp
```

Verify the DNS resolution:

```bash
nslookup nginx.k3s.differentpla.net localhost
```

Output:

```
Server:    127.0.0.1
Address 1: 127.0.0.1 localhost

Name:      nginx.k3s.differentpla.net
Address 1: 192.168.28.11
```

### [Pod DNS Problems](#pod-dns-problems)

Note that this setup doesn't work for DNS queries from inside a container. For details, see [Pod DNS Problems](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/) and [CoreDNS Customization](https://coredns.io/plugins/kubernetes/).

By following these steps, you can use CoreDNS for LoadBalancer addresses in Kubernetes, ensuring seamless access to your services.
