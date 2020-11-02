+++
Categories = ["Rancher", "NGINX"]
Tags = ["Rancher", "NGINX", "ingress"]
date = "2019-11-20T00:03:00+00:00"
more_link = "yes"
title = "Rancher SSL Passthrough for NGINX ingress"
+++

Recently while setting up Vault inside Rancher. I ran into an issue with the NGINX ingress terminating TLS and forwarding traffic unencrypted to Vault.

<!--more-->
# [Prep work](#prep-work)

Before starting making any cluster changes, we'll want to take a etcd backup.

## rke managed clusters
<code>
rke etcd snapshot-save --config cluster.yml --name ssl-passthrough
</code>

## Rancher managed clusters
- In the Rancher UI, browse to the cluster and click the Cluster tab.
- Click the action menu and select "Snapshot Now".

[Edit Cluster](#edit-cluster)

## rke managed clusters
Edit cluster.yml to include the following:

<code>
ingress:
  provider: "nginx"
  extra_args:
    enable-ssl-passthrough: ""
</code>

Apply change to cluster:

<code>
rke up --config cluster.yml
</code>

## Rancher managed clusters
- In the Rancher UI, browse to the cluster and click the Cluster tab.
- Click the action menu and select "Edit".
- Click "Edit as YAML"
- Add the following

<code>
ingress:
  extra_args:
    enable-ssl-passthrough: ''
  provider: nginx
</code>

- Click "Save" at the bottom at the bottom of the page.

[Edit ingress](#edit-ingress)
- In the Rancher UI, browse to the ingress.
- Click the action menu and select "Edit".
- Go the label and add the following label.

<code>
nginx.ingress.kubernetes.io/ssl-passthrough=true
</code>

[Recycle NGINX](#recycle-nginx)
To apply these settings, we need to delete and recreate the NGINX pods in order to pick up this new flag.

Run this command to delete and recreated all the NGINX pods.

## NOTE
This change will cause connections to disconnect and reconnection.

<code>
for pod in $(kubectl get pods -l app=ingress-nginx -n ingress-nginx --no-headers -o name); do echo -n "$pod - "; kubectl delete $pod -n ingress-nginx; sleep 5; done
</code>

[Verify settings](#verify-nginx)
To apply these settings, we need to delete and recreate the NGINX pods in order to pick up this new flag.

Run this command to verify setting.

<code>
for pod in $(kubectl get pods -l app=ingress-nginx -n ingress-nginx --no-headers -o name); do echo -n "$pod - "; kubectl exec -n ingress-nginx -it $pod -- bash -c "ps aux | grep 'enable-ssl-passthrough' > /dev/null && echo OK || echo Problem"; done
</code>
