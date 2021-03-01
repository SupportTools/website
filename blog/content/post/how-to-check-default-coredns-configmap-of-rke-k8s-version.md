+++
Categories = ["Rancher", "NGINX"]
Tags = ["rancher", "nginx"]
date = "2020-10-23T14:28:00+00:00"
more_link = "yes"
title = "How to enable legacy TLS versions in Rancher's ingress-nginx"
+++

This article details how to enable TLS 1.1 on the ingress-nginx controller in Rancher Kubernetes Engine (RKE) CLI or Rancher v2.x provisioned Kubernetes clusters.

<!--more-->
# [Pre-requisites](#pre-requisites)

- A Kubernetes cluster provisioned by the Rancher Kubernetes Engine (RKE) CLI or Rancher v2.x
- For RKE provisioned clusters, you will require the RKE binary and access to the [cluster configuration YAML](https://rancher.com/docs/rke/latest/en/config-options/), [rkestate file](https://rancher.com/docs/rke/latest/en/installation/#kubernetes-cluster-state) and kubectl access with the kubeconfig for the cluster sourced
- For Rancher v2.x provisioned clusters, you will require [cluster owner or global admin permissions in Rancher](https://rancher.com/docs/rancher/v2.x/en/admin-settings/rbac/cluster-project-roles/)

# [Resolution](#resolution)

## Configuration for RKE provisioned clusters

1. Edit the cluster configuration YAML file to include the `ssl-protocols` option for the ingress, as follows:

    ```yaml
      ingress:
        provider: nginx
        options:
          ssl-protocols: "TLSv1.1 TLSv1.2"
    ```

2. Apply the changes to the cluster by invoking `rke up`:

    ```bash
    rke up --config <cluster configuration yaml file>
    ```

3. Verify the new configuration:

    ```bash
    for pod in $(kubectl get pods -l app=ingress-nginx -n ingress-nginx --no-headers -o name | awk -F '/' '{print $2}'); do echo -n "Checking $pod .... "; kubectl -n ingress-nginx exec "$pod" -- bash -c "cat /etc/nginx/nginx.conf | grep ssl_protocols | grep '1.1' > /dev/null 2>&1 && echo 'Good' || echo 'Bad'"; done
    ```

## Configuration for Rancher provisioned clusters

1. Login into the Rancher UI.
2. Go to Global -> Clusters -> Cluster Name
3. From the Cluster Dashboard, edit the cluster by Clicking on "⋮" then select Edit.
4. Click "Edit as YAML."
5. Include the `ssl-protocols` option for the ingress, as follows:

    ```yaml
    ingress:
      provider: nginx
      options:
        ssl-protocols: "TLSv1.1 TLSv1.2"
    ```

6. Click "Save" at the bottom of the page.
7. Wait for the cluster to finish upgrading.
8. Go back to the Cluster Dashboard and click "Launch kubectl."
9. Run the following inside the kubectl CLI to verify the new argument:

    ```bash
    for pod in $(kubectl get pods -l app=ingress-nginx -n ingress-nginx --no-headers -o name | awk -F '/' '{print $2}'); do echo -n "Checking $pod .... "; kubectl -n ingress-nginx exec "$pod" -- bash -c "cat /etc/nginx/nginx.conf | grep ssl_protocols | grep '1.1' > /dev/null 2>&1 && echo 'Good' || echo 'Bad'"; done
    ```
