+++
Categories = ["Rancher", "etcd"]
Tags = ["rancher", "etcd"]
date = "2021-02-28T23:22:00+00:00"
more_link = "yes"
title = "How to change etcd cipher suite in Rancher / RKE"
+++

This article will walk Rancher administrators through hardening the cluster communication between etcd nodes. We'll go over configuring etcd to use specific ciphers which enable stronger encryption for securing intra-cluster etcd traffic.

The cipher suites defined in the example could trade off speed for stronger encryption. Consider the level of ciphers in use and how they could impact the performance of an etcd cluster. Testing should be done to factor the spec of your hosts (cpu, memory, disk, network, etc...) and the typical types of interacting with kubernetes as well as the amount of resources under management within the k8s cluster.

<!--more-->
# [Pre-requisites](#pre-requisites)

- A Kubernetes cluster provisioned by the Rancher Kubernetes Engine (RKE) CLI or Rancher v2.x
- For RKE provisioned clusters, you will require the RKE binary and access to the [cluster configuration YAML](https://rancher.com/docs/rke/latest/en/config-options/), [rkestate file](https://rancher.com/docs/rke/latest/en/installation/#kubernetes-cluster-state) and kubectl access with the kubeconfig for the cluster sourced.
- For Rancher v2.x provisioned clusters, you will require [cluster owner or global admin permissions in Rancher](https://rancher.com/docs/rancher/v2.x/en/admin-settings/rbac/cluster-project-roles/)

# [Resolution](#resolution)
To make the modifications we'll be configuring our rke cluster YAML spec. This setting would be defined, then applied at the command line with the rke CLI, or alternately via the Rancher UI. From within the Rancher UI, navigate to the cluster you're looking to modify, and click edit under the 3 dot menu. From there, you should see a button labeled 'Edit as Yaml'. At the cluster YAML spec view we define the cipher-suites parameter under the etcd service definition. We recommend testing this out in a non-vital cluster before rolling out on important clusters to become familiar with the process.

```
services:
  etcd:
    extra_args:
      cipher-suites: "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384"
      election-timeout: "5000"
      heartbeat-interval: "500"
```
