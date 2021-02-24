+++
Categories = ["Rancher"]
Tags = ["rancher"]
date = "2021-02-17T19:21:00+00:00"
more_link = "yes"
title = "How to change the Rancher 2.x Server URL"
+++

This article details how to change the server URL for the Rancher v2.x cluster.

<!--more-->
# [Pre-requisites](#pre-requisites)

- [rancher-single-tool](https://github.com/rancherlabs/support-tools/raw/master/rancher-single-tool/rancher-single-tool.sh) for Single Server Rancher Installations
- [cluster-agent-tool](https://github.com/rancherlabs/support-tools/raw/master/cluster-agent-tool/cluster-agent-tool.sh) for both HA and Single Server Rancher Installations

# [Resolution](#resolution)
### Single Server Installation

During this tutorial, we recommended using the rancher-single-tool for Rancher single-server installations.  It isn't required, but it makes the process much more comfortable.  As a result, this guide will is based on using that tool.

- Download the rancher-single-tool to the node that is running your rancher server container.
```bash
wget https://github.com/rancherlabs/support-tools/raw/master/rancher-single-tool/rancher-single-tool.sh
```

- Backup your Rancher installation.
```bash
bash rancher-single-tool.sh -t'backup'
```

- Login to the Rancher web interface, navigate to the Global view by clicking the dropdown in the top left corner of the screen, and selecting "Global."  Then click "settings" in the middle of the top bar.  From the settings page, change the server-url to match your new server URL.

- Now, we need to upgrade your Rancher container to reflect new certs.  This is required in most cases, except when using a wildcard or SAN cert that also encompasses the new server-url.

    - To generate a new self-signed certificate for your new URL, use the following upgrade command.  Follow the prompts to finish the upgrade.

    ```bash
    bash rancher-single-tool.sh -t'upgrade' -s'newhostname.support.tools'
    ```

    - To generate a new Let's Encrypt certificate, you will need to change the Rancher server options to reflect this.  You could do this with the following command.

    ```bash
    bash rancher-single-tool.sh -t'upgrade' -r'--acme-domain newhostname.support.tools'
    ```

    - If you were using certificates signed by a recognized CA before and need to replace them, you should modify the docker options to reflect this change.  Keep in mind that if you just replaced the cert files on the host path and the filenames didn't change, you can restart the docker container.  However, if the filenames changed, I'm providing the example below of how you would upgrade the container to see this change.

    ```bash
    bash rancher-single-tool.sh -t'upgrade' -d'-d -p 443:443 -p 80:80 --restart=unless-stopped --volume=/etc/rancherssl/certs/cert.pem:/etc/rancher/ssl/cert.pem --volume=/etc/rancherssl/certs/key.pem:/etc/rancher/ssl/key.pem'
    ```

    - If you were using certificates signed by a private CA or self-signed certificates (certificates not created by rancher-single-tool option -s).  Below is an example of how you would do that.  The same rule applies from option c.  If the filenames have not changed, you don't need to upgrade, and you can restart the container.

    ```bash
    bash rancher-single-tool.sh -t'upgrade' -d'-d -p 443:443 -p 80:80 --restart=unless-stopped --volume=/etc/rancherssl/certs/cert.pem:/etc/rancher/ssl/cert.pem --volume=/etc/rancherssl/certs/key.pem:/etc/rancher/ssl/key.pem --volume=/etc/rancherssl/certs/ca.pem:/etc/rancher/ssl/cacerts.pem'
    ```

- Once your Rancher container is back up and running, you need to login to a single controlplane node for each of the downstream clusters and run the cluster-agent-tool.  Please see https://github.com/rancherlabs/support-tools/tree/master/cluster-agent-tool

### HA Installation

- Ensure that you have current etcd backups for your local rancher cluster.

- Login to the Rancher web interface, navigate to the Global view by clicking the dropdown in the top left corner of the screen, and selecting "Global."  Then click "settings" in the middle of the top bar.  From the settings page, change the server-url to match your new server url.

- Log into a box where you have helm and kubectl installed.  You will need your local Rancher cluster kubeconfig; ensure that it is set to the default config by either placing it in ~/.kube/config or by setting your KUBECONFIG environment variable.

- Check current helm chart options:

```bash
helm get values rancher -n cattle-system
hostname: oldhostname.support.tools
rancherImageTag: v2.5.5
```

- Craft an upgrade command based on the previous step's values and then modify the hostname to match the new server hostname/URL.

```bash
helm upgrade rancher-stable/rancher --name rancher --namespace cattle-system --set hostname=newhostname.support.tools --set rancherImageTag=v2.5.5
```

- Run the upgrade command, then wait for the rollout to complete.

```bash
kubectl -n cattle-system  rollout status deploy/rancher
```

- Once your Rancher deployment is back up and running, you need to login to a single controlplane node for each of the downstream clusters and run the cluster-agent-tool.  You also need to login to one of the controlplane nodes of your local Rancher cluster and run the cluster-agent-tool.  Please see https://github.com/rancherlabs/support-tools/tree/master/cluster-agent-tool
