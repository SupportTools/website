---
title: "A Deep Dive into Rancher: Managing Kubernetes at Scale"
date: "2023-09-19T21:50:00-06:00"
draft: false
tags: ["Rancher", "Kubernetes management", "controllers", "ag6ents", "WebSockets", "Rancher API", "CRDs"]
categories:
- Rancher
- Kubernetes

author: "Matthew Mattox - mmattox@support.tools."
description: "This comprehensive blog post explores Rancher's role in managing Kubernetes at scale. We delve into Rancher's architecture, covering controllers, agents, WebSockets, the Rancher API, and the use of Custom Resource Definitions (CRDs). Additionally, we'll explore Rancher's integration with Kubernetes networking, overlay networks, and traffic flows, including network plugins such as canal, flannel, and calico."
more_link: "yes"
---

# [Introduction to Rancher](#introduction-to-rancher)

Rancher is a powerful platform designed to simplify the management of Kubernetes clusters at scale. It is a comprehensive solution for deploying, orchestrating, and monitoring containerized applications within Kubernetes environments. Rancher's user-friendly interface and robust feature set make it an invaluable tool for DevOps teams and administrators dealing with complex containerized workloads.

# [Rancher's Architecture](#ranchers-architecture)

Rancher's architecture is the backbone of its functionality, ensuring that Kubernetes clusters are orchestrated, monitored, and maintained seamlessly. This section will dissect Rancher's architecture, highlighting the critical components that power this Kubernetes management platform.

## Rancher API - Norman

[Code](https://github.com/rancher/norman)

Rancher's API is built around a tool called Norman, a translation layer between the Kubernetes API and the Rancher API. Norman is a Go library that provides a RESTful interface for interacting with Kubernetes resources. It also handles authentication and authorization, ensuring only authorized users can access the API.

This is how Rancher's API works:

- The user sends a request to the Rancher API.
- Norman translates the request into a Kubernetes API call.
- The Kubernetes API updates the Rancher CRD
- Norman translates the response from the Kubernetes API into a Rancher API response.
- The Rancher API returns the response to the user.

It is important to note that some safeguards are in place inside Normon. For example, validating that all the required fields are present in the request before sending it to the Kubernetes API. This ensures that the Kubernetes API doesn't receive invalid requests. The Rancher UI handles most safeguards, for example, doing input validation. For example, making sure a blob of text looks like a plaintext cert.

## Rancher Controllers

Rancher's controllers are responsible for managing the state of the cluster and ensuring that the desired configuration is maintained. They are the brains behind Rancher's orchestration capabilities, making it possible to deploy, scale, and monitor Kubernetes clusters seamlessly. Here's a breakdown of the various types of controllers in Rancher:

NOTE: It is essential to understand that Rancher's controllers only run on the leader Rancher pod. This ensures that only one instance of each controller runs at any given time, preventing conflicts and ensuring consistency across the cluster. You can, of course, find the leader pod by running the following command:

```bash
kubectl -n kube-system get configmap cattle-controllers -o jsonpath='{.metadata.annotations.control-plane\.alpha\.kubernetes\.io/leader}'
```

```json
{
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": {
        "annotations": {
            "control-plane.alpha.kubernetes.io/leader": "{\"holderIdentity\":\"rancher-57cdf67b6c-r8gfs\",\"leaseDurationSeconds\":45,\"acquireTime\":\"2023-09-13T19:49:35Z\",\"renewTime\":\"2023-09-19T22:32:42Z\",\"leaderTransitions\":17}"
        },
        "creationTimestamp": "2023-08-13T08:46:39Z",
        "name": "cattle-controllers",
        "namespace": "kube-system",
        "resourceVersion": "31056281",
        "uid": "5aec849c-c7ed-4484-b0e6-9bc346027b7b"
    }
}
```

### Cluster Controller

The Cluster Controller is responsible for creating and managing Kubernetes clusters. It handles cluster provisioning, configuration, and monitoring.

#### RKE1

In RKE1, the Cluster Controller creates and manages RKE1 clusters. The basic workflow is as follows:

- Rancher creates a cluster object in the Rancher API. (clusters.management.cattle.io)
- Inside the cluster object is a `spec` section containing the cluster configuration. This includes the cluster name, Kubernetes version, nodes, etc. The most important part is the `rancherKubernetesEngineConfig` section, which contains the RKE1 configuration. (This is your cluster.yaml and rkestate file.)
- Then, the same GO code used by the RKE binary is baked into the Cluster controller. The code uses the same basic workflow as the RKE binary. It reads the cluster configuration from the cluster object and then creates the cluster. NOTE: The main difference is using node agents to provide access to the node instead of SSH. (It uses a SOCKET connection to the node instead of SSH.)
- At this point, the Cluster Controller uses all the same steps used by the RKE binary. This includes creating the etcd plane, control plane, and worker nodes. It also has things like installing the CNI, generating the kubeconfig, and installing the metrics server (addon jobs). NOTE: You'll notice that the log messages are the same as the RKE binary.

NOTE: There is a process of pulling the `cluster.yaml` and `cluster.rkestate` from the cluster object and then writing them to disk. You may run the RKE binary against the cluster. However, you must configure SSH access to the nodes, as the Cluster Controller does not handle this. Once this is done, it should be assumed that the Cluster Controller will no longer be able to manage the cluster. This should only be done for disaster recovery purposes, with the plan being to build a replacement cluster and migrate the workloads over to the new cluster after service has been restored.

#### RKE2/k3s

In RKE2/k3s, the Cluster Controller creates and manages RKE2/k3s clusters. The basic workflow is as follows:

- Rancher creates a cluster object in the Rancher API. (clusters.management.cattle.io)
- RKE2/k3s doesn't have a `cluster.yaml`. So, the configuration of the cluster is stored inside the cluster itself.
- Rancher only controls the Join URL and the token. The Join URL is created by bootstrapping the master node and then running the `rke2` binary with the `--server` flag. This creates the Join URL and the token. The token is stored in the cluster object, and the Join URL is stored in the cluster object and then passed to the node agents.
- The rest of the master and worker nodes then join the cluster.
- For RKE2/k3s upgrades, Rancher will update the crd `plans` on the downstream cluster. Then, the upgrade controller running inside will handle the upgrade. NOTE: The upgrade controller is a part of the RKE2/k3s binary. It is not a part of Rancher.

```bash
mmattox@a0ubthorp01:~$ kubectl get plans -n cattle-system
NAME               IMAGE                  CHANNEL   VERSION
rke2-master-plan   rancher/rke2-upgrade             v1.26.7+rke2r1
rke2-worker-plan   rancher/rke2-upgrade             v1.26.7+rke2r1
mmattox@a0ubthorp01:~$ 
```

[code](https://github.com/rancher/rancher/blob/v2.7.6/pkg/capr/configserver/server.go)

It's important to note that RKE2/k3s clusters are designed to be self-managing. You can manage the cluster directly using the RKE2/k3s binary. Rancher only manages the cluster during the initial creation process. After that, the cluster is managed by RKE2/k3s itself. Also, an imported RKE2/k3s cluster can be controlled by Rancher in the sense that we can update the CRD to kick off upgrades. However, the actual upgrade process is handled by RKE2/k3s itself.

### Project Controller

The Project Controller manages projects within a cluster. It handles project creation and configuration. It also handles project membership, ensuring only authorized users can access the project. It's imperative to understand that Projects are a Rancher concept, not a Kubernetes concept. This means that Rancher is responsible for managing projects rather than Kubernetes. This is why you can't see projects in the Kubernetes API. They are only visible in the Rancher API. For the namespaces, they only have some weird labels and annotations. This is because Rancher uses the labels and annotations to map the namespaces to the projects.

The Project controllers handle syncing objects in both the namespaces. For example, project secrets are defined at the project level instead of the namespace level. The secret is stored in Rancher; the controller copies the secret to all namespaces in the project.

[code](https://github.com/rancher/rancher/blob/master/pkg/generated/norman/management.cattle.io/v3/zz_generated_project_controller.go)

### RBAC Controller

The RBAC Controller manages the syncing of users, roles, and permissions on the downstream cluster. A downstream cluster needs to learn what a GitHub or AD user is. This is done by creating a service account on the downstream cluster and then creating a token for that service account. The token is then used to authenticate the user to the downstream cluster. The RBAC controller also handles syncing the roles and permissions from Rancher to the downstream cluster. This is done by creating a role on the downstream cluster and then binding the role to the service account. This ensures that the user has the correct permissions on the downstream cluster.

NOTE: It's crucial to understand that you should limit the number of roles and users assigned to your clusters because giving 100 users access to a cluster means 100 service accounts, each of its role and rolebinding. This can load the downstream cluster, including the agent caching layer. This is why limiting the number of users and roles assigned to your clusters is essential.

[code](https://github.com/rancher/rancher/blob/master/pkg/generated/norman/management.cattle.io/v3/zz_generated_cluster_role_template_binding_controller.go)

## Agents in Rancher

Rancher does not directly reach out to the Kubernetes APIs for the downstream clusters that it manages. Instead, it uses agents to communicate with the Kubernetes API. Agents are responsible for managing individual nodes within a Kubernetes cluster. They interact with controllers to ensure proper node configuration, deployment of workloads, and monitoring.

There are several different types of agents in Rancher:

- **Cluster Agent**: The Cluster Agent is responsible for managing the state of the cluster. It handles cluster provisioning, configuration, and monitoring. In v2.6+, the Cluster Agent runs in HA mode with two pods running simultaneously but only one active at a time. Inside the agent, a caching layer stores information about the cluster, with the startup process being that it pulls the data from the cluster and then caches it locally. Several informers watch for changes to the cluster and then update the cache accordingly.

In addition to providing a caching layer, the Cluster Agent also handles proxying Kubernetes API requests to the downstream cluster. This ensures that all requests are routed through the Cluster Agent, preventing direct access to the Kubernetes API. This is done by creating a WebSocket connection to the Rancher leader pod and then inside that pod. It binds to a random port on `127.0.0.1`. Then, when Rancher wants to communicate with the downstream cluster, it sends the request to `127.0.0.1:RandomPort`, which is then proxied to the Cluster Agent. The Cluster Agent then forwards the request to the Kubernetes API.

[code](https://github.com/rancher/rancher/blob/master/cmd/agent/main.go)

- **Node Agent**: The Node Agent manages individual nodes within a Kubernetes cluster. It handles node provisioning and configuration. The Node Agent runs on each node in the cluster, ensuring that all nodes are appropriately configured.

It is important to note that not all Rancher clusters will have node agents. For example, imported clusters do not have node agents. This is because Rancher does not directly access the nodes in an imported cluster. Instead, it relies on the cluster's existing infrastructure to manage the nodes.

NOTE: In older versions of Rancher (2.4 and below), the Node Agent was also used as a backup connection to the Kubernetes API. This is no longer the case in newer versions of Rancher, as the Cluster Agent HA mode replaced this.

[code](https://github.com/rancher/rancher/blob/master/cmd/agent/main.go)

- **Rancher System Agent**: The Rancher System Agent is responsible for managing installing RKE2/k3s on the nodes in a cluster. It handles creating the RKE2/k3s config files and then running the install script. It does this by running a systemd service on each node in the cluster. The service is called `rancher-system-agent`. This service calls the Rancher API to register the node with the cluster. It creates the config files in the location specified by the `RANCHER_SYSTEM_AGENT_CONFIG_DIR` environment variable, which defaults to `/var/lib/rancher/system-agent/etc.`.

It then downloads the RKE2/k3s install script and runs it. Once the install script is complete, the service calls the Rancher API to update the node status to `Waiting to register with Kubernetes.` This means the node is ready to be added to the cluster. The node will remain in this state until it is added to the cluster. Once the node is added to the cluster, the service calls the Rancher API to update the node status to `Active`, but it gets this from the Kubernetes API. This means the node is now part of the cluster and ready to be used.

NOTE: The Rancher System Agent is only used for RKE2/k3s clusters. For RKE clusters, the Node Agent is used instead. This service is not required after the node has successfully joined the cluster. This is because RKE2/k3s handles all the node management internally. However, it is still helpful for debugging as it provides a way to see what is happening on the node. The main benefit is that you might need Rancher to regenerate the config files if the bootstrap node changes. This can be done by restarting the service on the node.

[code](https://github.com/rancher/system-agent)

### Limitations of Agents

Agents are a powerful tool for managing Kubernetes clusters but have some limitations. 

- SSL - The agents are designed to connect and communicate with an HTTPS endpoint. This means that if you use a self-signed certificate, you must add the certificate to the agent's trust store. This is where the `--ca-checksum` flag comes in handy. This flag passes an SHA-256 hash of the Root Certificate. The agent then uses this hash to verify the certificate. The agent will not connect to the cluster if the hash does not match. This ensures that only trusted certificates are used.
- Network - The agents are designed to communicate over the overlay network, so the CNI must be up, running, and healthy for the agents to work correctly. This is why monitoring the CNI and ensuring it works properly is vital.
- DNS - The agents are designed to use the cluster's DNS server, so the DNS server must be up, running, and healthy for the agents to work correctly. This is why monitoring the DNS server and ensuring it is working properly is vital.
- Sticky connection to Rancher - The agents are designed to connect to Rancher and hold that connection forever. If you are making DNS names or IP changes, the agents will pick the changes up once they reconnect to Rancher. The agents also cache the DNS record, so restarting the agent after making DNS changes is essential. For example, in a DR failover scenario, you would need to restart the agents after the updated DNS records. NOTE: After 5 to 10 minutes, the agents should reconnect independently, but recycling the agents after making DNS changes is still a good idea.
- Caching is crazy - The agents like to cache resources because they rely on the Informer's hooks to update the cache. If that connection is unstable (Control plane nodes restarting, for example), the cache can get out of sync. This can cause issues with the agents where the agent shows as up and active, but you can't see resources inside the cluster in Rancher. Restarting the agent will fix this issue, tho it could be better. NOTE: This is a known issue and is being worked on. Grab the logs before restarting the agent and open a support ticket.

## WebSockets in Rancher

WebSockets are the communication glue that binds Rancher's components together. They enable real-time communication, allowing controllers, agents, and other components to exchange information and updates instantly. WebSockets are pivotal in Rancher's responsiveness and agility, ensuring that changes and events are quickly propagated throughout the system.

NOTE: It's important to understand without WebSockets, Rancher will not work, and the agents will flap up and down.

You can use this tool to test the WebSocket connection to Rancher:

[code](https://gist.github.com/superseb/89972344508e99b9336ad7eff78cb928)
```bash
curl -s -i -N \
                            --http1.1 \
                            -H "Connection: Upgrade" \
                            -H "Upgrade: websocket" \
                            -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
                            -H "Sec-WebSocket-Version: 13" \
                            -H "Authorization: Bearer token-xxxxx:string" \
                            -H "Host: rancher.yourdomain.com" \
                            -k https://rancher.yourdomain.com/v3/subscribe
```
