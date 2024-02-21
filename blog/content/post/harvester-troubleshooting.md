---
title: "Solving Harvester Operational Challenges: Expert Troubleshooting Techniques"
date: 2024-02-21T00:00:00-05:00
draft: false
tags: ["Harvester HCI", "Problem Solving"]
categories:
- Virtualization
- Tech Solutions
author: "Matthew Mattox - mmattox@support.tools."
description: "Unlock solutions to common Harvester HCI challenges, including cluster deployment, proxy configurations, and secure connections. Elevate your troubleshooting skills with this guide."
more_link: "yes"
---

Master the art of troubleshooting Harvester with this detailed guide. From overcoming cluster deployment hurdles to ensuring smooth access to embedded dashboards, we provide you with the tools and insights needed to address common pitfalls. This guide not only offers solutions but also enhances your troubleshooting skills with additional steps and SEO-friendly content to ensure you can navigate through Harvester’s intricacies with ease.

<!--more-->

## [Troubleshooting Harvester Operational Challenges](#harvester-troubleshooting)

Harvester, a powerful HCI solution, can encounter operational challenges that require expert troubleshooting. This guide provides comprehensive solutions to common issues, ensuring a seamless Harvester experience.

## [Install hanging at rke2-images](#install-hanging-rke2-images)

GH Issue: [3018](https://github.com/harvester/harvester/issues/3018) [Code:](https://github.com/harvester/harvester-installer/blob/885ac164a648768ce9db2b442290575717876c68/package/harvester-os/files/usr/sbin/harv-install#L168)

When installing Harvester via the ISO image, the process may hang at the `rke2-images` stage when using iDRAC or RSA KVM. This issue is caused by the installation process trying to pull the `rke2-images` from the ISO image and failing to do so due to the source being too slow.

### [Solution](#install-hanging-solution)

- Physically attach a USB drive or DVD drive to the server and mount the Harvester ISO image for the installation process.
- Don't use iDRAC or RSA KVM over a slow network connection for the installation process IE a VPN.
- Ignore the `rke2-images` stage and continue with the installation process as the images will be pulled from the internet during the first boot.

## [The first node is stuck in the "Pending" state](#first-node-stuck-pending)

When creating a Harvester cluster, the first node may get stuck in the "Pending" state, preventing the cluster from being created. This issue can be caused by a variety of factors, including network issues, misconfigured settings, or a lack of resources.

### [Solution](#first-node-stuck-solution)

- Wait, as the first node may take some time (15~20mins) to initialize and become ready.
- SSH into the first node and check the logs for any errors or issues.
- Ensure the first node has enough resources to run Harvester. The minimum requirements are 8 CPU cores, 32GB of RAM, and 500GB of disk space.

## [Second node fails to join the cluster](#second-node-fails-join)

After successfully creating the first node, the second node may fail to join the cluster, preventing the cluster from expanding. This issue can be caused by network issues, misconfigured, or first node not being ready.

### [Solution](#second-node-fails-join-solution)

- Ensure the first node is 100% ready and operational before attempting to add the second node.
- Check and verify the Harvester UI is accessible and operational.
- Verify the Harvester VIP is accessible and operational.
- Check firewall rules between the first and second node to ensure they can communicate with each other. See the RKE2 documentation for more information on the required ports and protocols. [RKE2 Ports](https://docs.rke2.io/install/requirements#inbound-network-rules)

## [Incorrect HTTP Proxy Configurations](#cluster-deployment-http-proxy)

When setting up a multi-node Harvester cluster, HTTP proxy configurations can cause issues, preventing the cluster from being created or expanded.

### [Solution](#cluster-deployment-http-proxy-solution)

- It's important to adjust the NO_PROXY environment variable to include the Harvester VIP and the IP addresses of the nodes in the cluster. For example, `localhost,127.0.0.1,0.0.0.0,10.0.0.0/8,longhorn-system,cattle-system,cattle-system.svc,harvester-system,.svc,.cluster.local.` This will ensure that the nodes can communicate with each other and the Harvester VIP without going through the HTTP proxy IE we don't want the nodes to go out to the proxy to communicate with each other.
- If you're using the Harvester ISO image, you can set the HTTP proxy during the installation process by adding `http_proxy=http://your-proxy:port` to the kernel command line. This will set the HTTP proxy for the installation process and the first boot.

## [CNI / Networking Issues](#cni-networking-issues)

CNI / Networking issues can cause a variety of problems, including nodes not being able to communicate with each other, pods not being able to communicate with each other, and pods not being able to communicate with the outside world.

It's important to ensure that the CNI / Networking is properly configured and operational to prevent these issues. In addition, it's important to remember that Harvester uses RKE2, which uses canal with multus.

### [Solution](#cni-networking-issues-solution)

- SSH into one of the master nodes and run `kubectl get nodes` to ensure all the nodes are in the `Ready` state.
- Run `kubectl -n kube-system get pods` to ensure all the pods are in the `Running` state.
- Run the overlay network test to ensure the nodes can communicate with each other. This can be done by creating a pod on each node and pinging the pod on the other node. If the pods can communicate with each other, the overlay network is operational. See the official docs at [KB000020831](https://www.suse.com/support/kb/doc/?id=000020831)

## [Secure Connections to the Harvester UI](#secure-connections-harvester-ui)

When accessing the Harvester UI by default the page uses a self-signed certificate, which can cause issues with browsers and other clients. It's important to ensure that the connections to the Harvester UI are secure and trusted.

### [Solution](#secure-connections-harvester-ui-solution)

- Replace the self-signed certificate with a trusted certificate from a Certificate Authority (CA). See the official docs at [Advanced Settings](https://docs.harvesterhci.io/v1.2/advanced/index#ssl-certificates)

### [Capturing Logs](#capturing-logs)

If you're still experiencing issues after following the solutions provided, it's important to capture the logs and provide them to the Harvester team for further assistance.

- If you're experiencing issues with the installation process, you can capture the logs by running `journalctl -u harvester-installer` and `journalctl -u harvester-installer-iso` on the installer node.
- If you're experiencing issues with the cluster, you can capture the logs by generating a support bundle from the Harvester UI. See the official docs at [Support Bundle](https://docs.harvesterhci.io/v1.2/troubleshooting/harvester#generate-a-support-bundle)
- If you're experiencing issues with the Harvester UI, you can capture the logs by following the official docs at [Manually Download and Retain a Support Bundle File](https://docs.harvesterhci.io/v1.2/troubleshooting/harvester#generate-the-file-and-prevent-automatic-downloading)
- Access the Harvester UI and navigate to `System` > `Support Bundle` > `Download` to capture the logs.
- If you can also access the hidden support page by navigating to `Preferences` and check the `Enable Extension developer features` box under `Advanced Features`. Then navigate to `Support` at the bottom left of the page.
- If you're still experiencing issues with Longhorn, you can capture the logs by following the official docs at [Longhorn Troubleshooting](https://longhorn.io/docs/1.4.3/troubleshoot/). Note: Longhorn is the default storage solution for Harvester and is tightly integrated with Harvester so it's important to not make any changes to Longhorn without consulting the Harvester team and/or the Longhorn team.

## [Conclusion](#conclusion)

By following the solutions provided in this guide, you can overcome common Harvester operational challenges and ensure a seamless experience. Elevate your troubleshooting skills and unlock the full potential of Harvester HCI.
