---
title: "Who is Norman and Why Does He Do So Much Work?"  
date: 2024-11-19T19:26:00-05:00  
draft: false
tags: ["Rancher", "Norman", "Kubernetes", "CRD"]  
categories:  
- Rancher  
- Kubernetes  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Explore Rancher's Norman framework, its purpose, and how it simplifies the interaction between Kubernetes resources and Rancher's API, including an example of API calls converted into CRDs."  
more_link: "yes"  
url: "/who-is-norman-and-why-does-he-do-so-much-work/"  
---

Rancher’s Norman is a key component of the Rancher ecosystem. It not only facilitates API interactions between Rancher and Kubernetes but also powers the internal operations of Rancher server pods, ensuring consistency and reliability across multiple deployments.

[Norman GitHub Repository](https://github.com/rancher/norman)

<!--more-->

![Rancher Components Diagram](https://ranchermanager.docs.rancher.com/assets/images/ranchercomponentsdiagram-2.6-3ddd4fe509fb4257ab397c51400855f3.svg)  

*Figure: Rancher Components Overview*

# [What is Rancher's Norman?](#what-is-ranchers-norman)  

## Section 1: Introduction to Norman  
Norman provides a structured way to define and manage Kubernetes resources. It acts as the backbone of Rancher’s API, translating Rancher API calls into Kubernetes-native operations. Beyond just an API framework, Norman is integral to how Rancher server pods operate and manage workloads.

## Section 2: How Norman Powers Rancher Server Pods  

Rancher server consists of multiple pods running on Kubernetes. Each of these pods is responsible for handling API requests, managing resources, and maintaining cluster state. Norman plays a pivotal role in this process by:

### [Coordinating API Requests](#coordinating-api-requests)  
Norman ensures that all incoming Rancher API requests are distributed and handled correctly across Rancher server pods. It abstracts the underlying complexity of interacting with Kubernetes resources, making API operations seamless and efficient.

### [Managing CRDs and Controllers](#managing-crds-and-controllers)  
Norman dynamically manages the creation, update, and deletion of Custom Resource Definitions (CRDs) and their corresponding controllers. For example, when a new cluster is created in Rancher, Norman ensures the corresponding `Cluster` CRD is created and kept in sync with the Kubernetes cluster.

### [Example: API Call to CRD](#example-api-call-to-crd)  

Here’s an example of how Norman handles an API call and converts it into a Kubernetes CRD:

#### [API Call Using `curl`](#api-call-using-curl)  

```bash
curl -u "${CATTLE_ACCESS_KEY}:${CATTLE_SECRET_KEY}" \
-X GET \
-H 'Accept: application/json' \
-H 'Content-Type: application/json' \
'https://rancher.example.com/v3/clusters/c-m-abcd1234'
```

Sample Response (truncated):

```json
{
  "id": "c-m-abcd1234",
  "name": "lab-cluster",
  "state": "active",
  "version": {
    "gitVersion": "v1.30.6+rke2r1"
  },
  "capacity": {
    "cpu": "24",
    "memory": "48818048Ki",
    "pods": "330"
  }
}
```

#### [Corresponding CRD in Kubernetes](#corresponding-crd-in-kubernetes)  

Norman translates the API response into a `Cluster` CRD:

```yaml
apiVersion: management.cattle.io/v3
kind: Cluster
metadata:
  name: c-m-abcd1234
  labels:
    provider.cattle.io: rke2
  annotations:
    authz.management.cattle.io/creator-role-bindings: '{"created":["cluster-owner"],"required":["cluster-owner"]}'
  finalizers:
  - wrangler.cattle.io/mgmt-cluster-remove
spec:
  displayName: lab-cluster
  desiredAgentImage: rancher/rancher-agent:v2.9.3
  fleetWorkspaceName: fleet-default
  dockerRootDir: /var/lib/docker
status:
  state: active
  version:
    gitVersion: v1.30.6+rke2r1
  capacity:
    cpu: "24"
    memory: 48818048Ki
    pods: "330"
...
```

### [Powers the Rancher UI](#powers-the-rancher-ui)  
The Rancher UI interacts with Norman to access Kubernetes resources instead of directly interacting with the Kubernetes API. This abstraction layer simplifies UI development and ensures consistent behavior across Kubernetes environments.

### [Ensuring High Availability](#ensuring-high-availability)  
Norman works across all Rancher server pods to ensure high availability. If one pod goes down, others can take over seamlessly, maintaining Rancher’s operational status.

## [Conclusion](#conclusion)  
Norman is the engine that powers Rancher server pods. By providing a robust, reliable framework, it ensures Rancher can manage Kubernetes clusters at scale, delivering a seamless user experience.

To learn more, visit the [Norman GitHub Repository](https://github.com/rancher/norman).
