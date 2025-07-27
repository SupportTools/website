---
title: "Kubernetes Events: How to Keep Historical Data of Your Cluster Elasticsearch"
date: 2022-10-13T09:30:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Management", "Event Logging"]
categories:
- Kubernetes
- Cluster Management
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to retain historical Kubernetes events for effective cluster troubleshooting and monitoring."
more_link: "yes"
---

## Kubernetes Events: How to Keep Historical Data of Your Cluster

Are you running a Kubernetes cluster in production? If so, you've likely encountered unexpected issues that can disrupt your applications. Recently, I had a production application POD crash, and it took me hours to discover that it was OOMKilled. Surprisingly, I couldn't find relevant information when running the kubectl event command.

I later discovered that Kubernetes only retains event history for a mere 1 hour by default. While you can customize this by tweaking the kube-apiserver with a special flag, most clusters stick with the default setting:

```bash
--event-ttl duration     Default: 1h0m0s
Amount of time to retain events.
```

Realizing that my cluster could not keep historical event data, I explored solutions. I typically use the EFK (Elasticsearch, Fluentd, Kibana) stack to store application logs, and it would be ideal to extend it to include Kubernetes events and logs.

That's when I came across Metricbeat, an official Elasticsearch beat designed for various data sets and use cases. It includes a dedicated module for Kubernetes and is available as a Helm chart in the official stable repository. However, there were some challenges when connecting it to my managed AWS Elasticsearch:

- AWS Elasticsearch listens on port 443, not the usual 9200.
- AWS Elasticsearch doesn't use basic authentication (username & password).
- Metricbeat used with AWS Managed Elasticsearch must be the Open Source (OSS) version.

Unfortunately, the official documentation didn't cover these issues, so I had to dig into GitHub and StackOverflow for solutions.

To install Metricbeat on my cluster using Helm v3, I followed these steps:

```bash
# Add the stable repository to your Helm
helm repo add stable https://kubernetes-charts.storage.googleapis.com

# Install kube-state-metrics
helm install kube-state-metrics -n kube-system stable/kube-state-metrics

# Install Metricbeat
helm install metricbeat -n kube-system stable/metricbeat --values values.yaml
```

The default Helm configuration works for most deployments, but it lacked the "metricset event" I needed. So, I made a minor adjustment in the `values.yaml` file to enable it:

```yaml
# values.yaml
image:
  repository: docker.elastic.co/beats/metricbeat-oss
  tag: 6.7.0
daemonset:
  overrideConfig:
    metricbeat.config.modules:
      path: ${path.config}/modules.d/*.yml
      reload.enabled: false
    processors:
      - add_cloud_metadata:
    output.elasticsearch:
      hosts: ['${ELASTICSEARCH_HOST:elasticsearch}:${ELASTICSEARCH_PORT:9200}']
deployment:
  overrideConfig:
    metricbeat.config.modules:
      path: ${path.config}/modules.d/*.yml
      reload.enabled: false
    processors:
      - add_cloud_metadata:
    output.elasticsearch:
      hosts: ['${ELASTICSEARCH_HOST:elasticsearch}:${ELASTICSEARCH_PORT:9200}']
      ssl:
        verification_mode: "none"
  modules:
    kubernetes:
      enabled: true
      config:
        - module: kubernetes
          metricsets:
            - state_node
            - state_deployment
            - state_replicaset
            - state_pod
            - state_container
            - event
          period: 10s
          hosts: ["kube-state-metrics:8080"]
extraEnv:
  - name: ELASTICSEARCH_HOST
    value: "https://vpc-elasticsearch-xxxvvvbbbzzzssss.eu-west-1.es.amazonaws.com"
  - name: ELASTICSEARCH_PORT
    value: "443"
```

This Helm chart installs Metricbeat as a DaemonSet and Deployment, along with the necessary configurations and secrets. It also sets up RBAC (Role-Based Access Control) objects to allow Metricbeat to access cluster metrics.

With Metricbeat installed, I opened the Kibana dashboard, created a new index pattern (e.g., `metricbeat-*`), and began searching for events in Kibana.

For testing purposes, I created a pod to demonstrate OOMKilled behavior, and to my dismay, I couldn't find the relevant event in Kibana. Checking Kubernetes events using `kubectl get events` showed a "BackOff" event but not the crucial "OOMKilled" event.

Digging deeper, I discovered that the information I needed was available in the pod description:

```bash
State:          Waiting
Reason:       CrashLoopBackOff
Last State:     Terminated
  Reason:       OOMKilled
  Exit Code:    1
```

This "Reason: OOMKilled" field was what I needed to ship to Elasticsearch. Metricbeat documentation pointed me to the `kubernetes.container.status.reason` field in the metricset `apiserver`. To enable this metricset, I made a slight configuration adjustment, as shown below:

```yaml
# values.yaml
deployment:
  overrideConfig:
    metricbeat.config.modules:
      path: ${path.config}/modules.d/*.yml
      reload.enabled: false
    processors:
      - add_cloud_metadata:
    output.elasticsearch:
      hosts: ['${ELASTICSEARCH_HOST:elasticsearch}:${ELASTICSEARCH_PORT:9200}']
      ssl:
        verification_mode: "none"
  modules:
    kubernetes:
      enabled: true
      config:
        - module: kubernetes
          metricsets:
            - state_node
            - state_deployment
            - state_replicaset
            - state_pod
            - state_container
            - event
          period: 10s
          hosts: ["kube-state-metrics:8080"]
        - module: kubernetes
          metricsets:
            - apiserver
          hosts: ["https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"]
```

After making this change, I refreshed the Metricbeat index in Kibana, and voilà! I could filter for OOMKilled pods in my cluster using `kubernetes.container.status.reason: OOMKilled`.

With this setup, I had logs related to OOMKilled events in Elasticsearch, access to Kubernetes events, and a wealth of cluster metrics and logs stored persistently.

This configuration will save me valuable time in the future when troubleshooting issues with my pods. Consider this setup for your Kubernetes cluster to enhance your monitoring and debugging capabilities.

## References

- [Metricbeat Kubernetes Module](https://www.elastic.co/guide/en/beats/metricbeat/current/metricbeat-module-kubernetes.html)
