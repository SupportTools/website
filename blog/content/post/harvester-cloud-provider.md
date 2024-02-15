---
title: "Running RKE2 Clusters on-top Harvester Using the Cloud Provider and Rancher"
date: 2024-02-14T10:00:00-05:00
draft: false
tags: ["Harvester", "RKE2", "Kubernetes"]
categories:
- Harvester
- RKE2
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A step-by-step guide on setting up and running an RKE2 clusters on-top of Harvester using the built-in cloud provider for enhanced integration with Kubernetes."
more_link: "yes"
---

Learn how to seamlessly integrate RKE2 clusters with Harvester's infrastructure capabilities using the Harvester cloud provider. This workshop guide covers the entire process from initial setup to cluster deployment and configuration.

<!--more-->
## [Getting Started with Harvester and RKE2](#getting-started-with-harvester-and-rke2)

In this workshop, we'll walk through the process of deploying RKE2 clusters within Harvester, leveraging the Harvester cloud provider for native Kubernetes integration. This enables advanced features such as dynamic volume provisioning and load balancer support, enhancing your Kubernetes workloads with Harvester's infrastructure capabilities.

## Prerequisites

Before starting, ensure you have the following:

- A Rancher Server deployed and accessible.
- A Harvester setup ready to host virtual machines.
- Access to the Harvester UI or kubectl configured for your Harvester cluster.
- Basic understanding of Kubernetes cluster deployment.
- Familiarity with RKE2 and its configuration options.

## Workshop Outline

This workshop is divided into the following sections:

1. Setting Up the Harvester Environment
2. Deploying an RKE2 Cluster
3. Verifying the Harvester Cloud Provider
4. Recommended and Best Practices
5. Troubleshooting and Debugging

### [Setting Up the Harvester Environment](#setting-up-the-harvester-environment)

Before we begin, ensure that your Harvester environment is connected to your Rancher server. This allows you to manage your Harvester clusters from the Rancher UI and use the Harvester cloud provider.

- Log into your Rancher server and navigate to the "Global" view.
- Browse to the "Global Apps" section and click on "Virtualization Management".
- Click on "Add Cluster" and select "Harvester" from the list of available providers.
- Note, the registration URL
- Log into your Harvester environment and navigate to Advanced Settings > Settings
- Find the setting "cluster-registration-url" and set it to the registration URL from the previous step.
- Save the settings and wait for the cluster to appear in the Rancher UI. This may take a few minutes.
- Once the cluster appears, you can manage it from the Rancher UI.
- You can now proceed to create the Cloud Credentails for the Harvester.
- Go back to the Rancher UI and navigate to the "Cluster Management" section.
- Click on "Cloud Credentials" and select "Add Cloud Credential".
- Choose "Harvester" as the cloud provider and fill out the name and description fields.
- Select the Harvester cluster you want to connect to from the "Imported Harvester Cluster" dropdown.

Now we need to setup a cloud-image for use in the RKE2 cluster.

- Log into the Harvester UI and navigate to the "Images" section.
- Click on "Create" and fill out the name and description fields.
- For namespace, select `default`
- For the URL, use the following URL: `https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img`
- Click on "Create" to create the cloud-image.

If you want to use OpenSUSE, you can use the following URL: `https://download.opensuse.org/repositories/Cloud:/Images:/Leap_15.3/images/openSUSE-Leap-15.3.x86_64-NoCloud.qcow2`

You can also use other cloud images from the cloud provider of your choice. Just make sure the image is in the img or qcow2 format. And the keyword to use when searching is `Cloud Image` or `Cloud-Init Image`. These are base images that are pre-configured to work with cloud-init.

At this point, Rancher is connected to your Harvester environment and can create VMs in your Harvester cluster just like any other cloud provider IE AWS, GCP, Azure, etc.

### [Deploying an RKE2 Cluster](#deploying-an-rke2-cluster)

Now that the Harvester environment is set up, we can proceed to deploy an RKE2 cluster but first, we need to create a namespace and a service account in the Harvester cluster.

- Log into the Harvester UI and navigate to the "Namespaces" section.
- Click on "Create" and fill out the name and description fields. For example, "rke2-lab-01".
- Click on "Create" to create the namespace. Note: You can use the default namespace if you prefer but it's best practice to use a dedicated namespace for each RKE2 cluster.

Next, we need to create a service account in the namespace we just created.

- Setup the kubectl context for the Harvester cluster or SSH into the Harvester node and run the following command:

```bash
wget https://raw.githubusercontent.com/harvester/cloud-provider-harvester/master/deploy/generate_addon.sh
chmod +x generate_addon.sh
./generate_addon.sh -n rke2-lab-01 rke2-lab-01 
```

This will create a service account and a cluster role binding for the service account in the namespace we created.

The output will look something like this:

```bash
Creating target directory to hold files in ./tmp/kube...done
Creating a service account in default namespace: harvester-cloud-provider
W1104 16:10:21.234417    4319 helpers.go:663] --dry-run is deprecated and can be replaced with --dry-run=client.
serviceaccount/harvester-cloud-provider configured

Creating a role in default namespace: harvester-cloud-provider
role.rbac.authorization.k8s.io/harvester-cloud-provider unchanged

Creating a rolebinding in default namespace: harvester-cloud-provider
W1104 16:10:21.986771    4369 helpers.go:663] --dry-run is deprecated and can be replaced with --dry-run=client.
rolebinding.rbac.authorization.k8s.io/harvester-cloud-provider configured

Getting uid of service account harvester-cloud-provider on default
Service Account uid: ea951643-53d2-4ea8-a4aa-e1e72a9edc91

Creating a user token secret in default namespace: harvester-cloud-provider-token
Secret name: harvester-cloud-provider-token

Extracting ca.crt from secret...done
Getting user token from secret...done
Setting current context to: local
Cluster name: local
Endpoint: https://HARVESTER_ENDPOINT/k8s/clusters/local

Preparing k8s-harvester-cloud-provider-default-conf
Setting a cluster entry in kubeconfig...Cluster "local" set.
Setting token credentials entry in kubeconfig...User "harvester-cloud-provider-default-local" set.
Setting a context entry in kubeconfig...Context "harvester-cloud-provider-default-local" created.
Setting the current-context in the kubeconfig file...Switched to context "harvester-cloud-provider-default-local".
########## cloud config ############
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: <CACERT>
    server: https://HARVESTER-ENDPOINT/k8s/clusters/local
  name: local
contexts:
- context:
    cluster: local
    namespace: default
    user: harvester-cloud-provider-default-local
  name: harvester-cloud-provider-default-local
current-context: harvester-cloud-provider-default-local
kind: Config
preferences: {}
users:
- name: harvester-cloud-provider-default-local
  user:
    token: <TOKEN>
    
    
########## cloud-init user data ############
write_files:
- encoding: b64
  content: <CONTENT>
  owner: root:root
  path: /etc/kubernetes/cloud-config
  permissions: '0644'
```

The output will contain the kubeconfig file and the cloud-init user data. Save the kubeconfig file and the cloud-init user data as we will need them later.
NOTE: `server` in the kubeconfig file should be set to the Harvester endpoint and not the local endpoint or your Rancher Proxy endpoint.

Once, you have the kubeconfig file you need to base64 encode it and put it in the content field of the cloud-init user data.

- Log into the Rancher UI and navigate to the "Cluster Management" section.
- Click on "Create" and select "RKE2".
- Click on Harvester
- Select the Harvester cluster you want to deploy the RKE2 cluster to from the "Cloud Credential" dropdown.
- Fill out the cluster name and description fields.

We will create the node pool(s). For this example, we will create a single node pool with 3 nodes, all roles, and the cloud-init user data we generated earlier.

- Fill out the following fields:
  - Name: pool1
  - Machine Count: 3
    - Roles: etcd, controlplane, worker
  - CPUs: 2
  - Memory: 4GiB
  - Namespace: rke2-lab-01  (or the namespace you created earlier)
  - SSH User: ubuntu
  - Node Count: 3
  - Roles: etcd, controlplane, worker
  - Under volumes, select the cloud-image you created earlier and set the size to 20GiB or the size you prefer. (This is the root volume for the VMs)
  - Under Network, select the network you want to use for the VMs. (This is the network the VMs will be attached to)
  - Click on the "Show Advance" button and paste the cloud-init user data we generated earlier in the "Cloud-init User Data" field.
  - Cloud-init User Data: Paste the cloud-init user data we generated earlier.

Example cloud-init user data:

```yaml
#cloud-config
write_files:
- encoding: b64
  content: YXBp....
  owner: root:root
  path: /etc/kubernetes/cloud-config
  permissions: '0644'
ssh_import_id:
  - gh:mattmattox
package_update: true
packages:
  - qemu-guest-agent
runcmd:
  - - systemctl
    - enable
    - '--now'
    - qemu-guest-agent.service
```

- For the `Cluster Configuration` section, you can leave the default settings or customize them to your preference. The key setting is the `Cloud Provider` field. Make sure it's set to `Harvester`.
- Click on "Create" to create the RKE2 cluster.

This will trigger Rancher to create the VMs in the Harvester cluster and deploy the RKE2 cluster on the VMs. With the basic processing to bootstrap one of the nodes then join the other nodes to the cluster. This process may take a few minutes to complete.

It is important to wait for the cluster to be in a "Ready" state before proceeding to the next step.

### [Verifying the Harvester Cloud Provider](#verifying-the-harvester-cloud-provider)

Once the RKE2 cluster is deployed, we can verify that the Harvester cloud provider is working as expected.

- Log into the Rancher UI and navigate to the cluster you just created.
- Click on the "Cluster Explorer" and navigate to the "Workloads" section.
- We are going to create a simple `hello-world` deployment to verify the cloud provider is working as expected.
- Click `Import YAML` and paste the following YAML:

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-world
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: hello-world
  template:
    metadata:
      labels:
        app: hello-world
    spec:
      containers:
      - name: hello-world
        image: "supporttools/hello-world:latest"
        ports:
        - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: hello-world
  namespace: default
spec:
  selector:
      app: hello-world
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
  type: LoadBalancer
```

- We now need to wait for the `hello-world` deployment to be in a "Running" state.
- Once the deployment is in a "Running" state, we can verify that the load balancer service is working as expected.
- Navigate to the "Services" section and find the `hello-world` service.
- Click on the service and copy the `External Endpoints` URL.
- Open a new browser tab and paste the `External Endpoints` URL.
- You should see the `hello-world` application running.

Now we need to verify that the dynamic volume provisioning is working as expected.

- Navigate to the "Storage" section and click on "Storage Classes".
- You should see a storage class named `harvester`.
- We are going to create a simple `busybox` pod to verify the dynamic volume provisioning is working as expected.
- Click `Import YAML` and paste the following YAML:

```yaml
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  namespace: default
spec:
  containers:
  - name: test-pod
    image: busybox
    command: ["/bin/sh", "-c", "while true; do echo $(date) >> /data/out.txt; sleep 5; done"]
    volumeMounts:
    - name: test-volume
    mountPath: /data
volumes:
- name: test-volume
    persistentVolumeClaim:
    claimName: test-pvc
```

- We now need to wait for the `test-pod` to be in a "Running" state.
- Once the pod is in a "Running" state, we can verify that the dynamic volume provisioning is working as expected.
- Navigate to the "Volumes" section and click on "Persistent Volume Claims".
- You should see a persistent volume claim named `test-pvc` in a "Bound" state.

At this point, we have verified that the Harvester cloud provider is working as expected and the RKE2 cluster is integrated with Harvester's infrastructure capabilities.

### [Recommended and Best Practices](#recommended-and-best-practices)

Here are some recommended and best practices to follow when deploying RKE2 clusters on-top of Harvester using the cloud provider:

- Use dedicated namespaces for each RKE2 cluster.
- Use dedicated service accounts for each RKE2 cluster.
- Use dedicated cloud-init user data to customize the VMs for each RKE2 cluster (IE: install additional packages, setup additional users, etc).
- Configure ingress-nginx to use the Harvester cloud provider for load balancer support.

Import the following YAML to customize the ingress-nginx that is deployed by default in the RKE2 cluster:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-ingress-nginx
  namespace: kube-system
spec:
  valuesContent: |-
    controller:
      publishService:
        enabled: true
      service:
        enabled: true
        annotations:
          cloudprovider.harvesterhci.io/ipam: dhcp
        type: LoadBalancer
```

This will create a LoadBalancer service for the ingress-nginx controller and the publishService will use the IP address from Harvester LoadBalancer.

If you are using a 1-to-1 NAT network, you can use the following:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-ingress-nginx
  namespace: kube-system
spec:
  valuesContent: |-
    controller:
      publishService:
        enabled: false
      extraArgs:
        publish-status-address: "1.2.3.4"
      service:
        enabled: true
        annotations:
          cloudprovider.harvesterhci.io/ipam: dhcp
        type: LoadBalancer
```

Replace `1.2.3.4` with the public IP address.

### [Troubleshooting and Debugging](#troubleshooting-and-debugging)

If you encounter any issues when deploying RKE2 clusters on-top of Harvester using the cloud provider, here are some troubleshooting and debugging tips:

- Check the Harvester UI for any errors or warnings.
- Check the Rancher UI for any errors or warnings.
- The deployment `harvester-cloud-provider` in the namespace `kube-system` acts a bridge between the RKE2 cluster and Harvester. Check the logs for this deployment for any errors or warnings.
- The deployment `harvester-csi-driver-controllers` in the namespace `kube-system` is responsible for the dynamic volume provisioning. Check the logs for this deployment for any errors or warnings. Note: Only one pod is leader and the others will set to `standby` state.
- The deamonset `harvester-csi-driver` in the namespace `kube-system` is responsible for connecting kubelet to the Harvester storage. Check the logs for this deamonset for any errors or warnings.

## Conclusion

In this workshop, we walked through the process of deploying RKE2 clusters within Harvester, leveraging the Harvester cloud provider for native Kubernetes integration. We verified that the cloud provider is working as expected and the RKE2 cluster is integrated with Harvester's infrastructure capabilities. We also covered some recommended and best practices to follow when deploying RKE2 clusters on-top of Harvester using the cloud provider.
