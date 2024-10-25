---
title: "Rancher Agents"
date: 2022-05-13T04:04:00-00:00
draft: false
tags: ["rancher", "agents", "training"]
categories:
- rancher
author: "Matthew Mattox - mmattox@support.tools"
description: "Rancher Agents"
---

# What do the Rancher/cattle agents do?
The Rancher agents are how Rancher communicates with downstream clusters. It's important to understand that Rancher does not create outbound connections to downstream clusters for gaining access to the Kubernetes API endpoint. This includes Rancher deployed clusters and imported clusters.


![rancher-architecture](../images/rancher-architecture-rancher-api-server.svg)


There are two different agent resources deployed on Rancher managed clusters:
- cattle-cluster-agent
- cattle-node-agent

## cattle-cluster-agents
In Rancher v2.5, the cattle-cluster-agent Deployment has a single replica; in Rancher v2.6, it runs as at least two replicas for HA. When this pod starts, it creates a WebSocket connection to Ranchers API.

Once connected, the cattle-cluster-agent creates a TCP tunnelled connection over the WebSocket connection back to Ranchers leader pod. It will bind to a random port on localhost inside the Rancher leader pod. In turn, this tunnel will allow Rancher server pods to connect to the downstream cluster.

Due to this, Rancher does not require firewall rules to open communication from Rancher servers to downstream servers, which eliminates the need for port-forwarding, which can pose a security risk. As long as this WebSocket connection is active, Rancher and the cattle-cluster-agent will be able to access the cluster.

If this connection is not active, Rancher will be unable to access the cluster. The cluster agent will make a connection to the kube-apiserver endpoint from inside the cluster.

**Note**: The cluster agent will [prefer to schedule on controlplane nodes](https://rancher.com/docs/rancher/v2.6/en/cluster-provisioning/rke-clusters/rancher-agents/#scheduling-rules), and connect to the Kubernetes API.

## cattle-node-agents
Since cattle-node-agents run as a DaemonSet, they will ignore all taints.

WebSockets are used by both node agents and cluster agents. There are two main differences between these pods: 

- The node-agents run on the host network, so do not get assigned IPs from the cluster CIDR, and do not use CoreDNS to resolve hostnames.
- The Docker socket is mounted into the pod, so Rancher can access the Docker on the nodes.

Standalone RKE uses SSH tunnels to manage the containers that make up an RKE cluster, including etcd, kubelet, kube-apiserver, etc. The node agents act like the SSH tunnels for Rancher deployed RKE clusters.

**Note**: Rancher uses the cattle-node-agent only when it needs a tunnel to each node for management, i.e. when an RKE cluster is created/updated. For imported clusters, for example Amazon EKS, the cattle-node-agent is not required. Furthermore, RKE2 and k3s use a different creation/management model. Therefore, node agents are slowly disappearing as the need for them has diminished.

---

Both agents use HTTPS to connect to the Rancher API. It is not possible to force the Rancher agents to use HTTP instead of HTTPS. The pods are configured with environment variables. 

`CATTLE_SERVER` is the hostname of the Rancher API. An example hostname is rancher.example.com. It is critical to note that HTTP or HTTPS is not included in this variable, since Rancher requires the agents to connect via HTTPS. 

`CATTLE_CA_CHECKSUM` is an SHA-256 checksum of the Rancher API certificate chain. If you use an internal or self-signed certificate, the pod will not trust that certificate, as the image does not have the root CA certificate. By decoding the Rancher API certificate chain and hashing it with SHA-256, the agents work around this issue. As long as the hash matches the `CATTLE_CA_CHECKSUM` variable, the agents will trust the HTTPS connection. If you renew the certificate in place, that is, without changing the chain, the `CATTLE_CA_CHECKSUM` variable will not change if you switch certificates to another authority - for example, if you switch from a self-signed certificate to one issued by DigiCert, GoDaddy, etc. Consequently, the `CATTLE_CA_CHECKSUM` variable will no longer match, requiring manual intervention to update the agents. You can find documentation on the different methods in [Updating a Private CA Certificate](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/resources/update-rancher-certificate#4-reconfigure-rancher-agents-to-trust-the-private-ca).

**Note**: The remaining environment variables are usually left at the default values.

`CATTLE_DEBUG` can be used to enable debug logging, when set to `true`. It is also possible to interactively run `loglevel --set debug` with an exec session into an agent container, this can be reverted by setting the `info` level again.

`CATTLE_TUNNEL_DATA_DEBUG` when set to `true` enables the output of data for tunnel connectivity with Rancher.

**Note**: It is possible to set variables on the Rancher agents when editing or creating a cluster, this depends on the cluster type.