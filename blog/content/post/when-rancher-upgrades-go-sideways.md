---
title: "When Rancher Upgrades Go Sideways"
date: 2023-12-06
draft: false
tags: ["Rancher", "Kubernetes", "Troubleshooting"]
categories:
- Kubernetes
- Rancher
- DevOps
author: "Matthew Mattox - mmattox@support.tools."
description: "Common Rancher upgrade failures and solutions."
---

Upgrading Rancher, the popular Kubernetes management platform, can be an essential task to ensure your cluster stays up-to-date with the latest features and security patches. However, sometimes Rancher upgrades can hit a roadblock, causing frustration for cluster administrators. In this post, we'll explore a common Rancher upgrade failure and provide a solution to get your upgrade back on track.

## Common Rancher Upgrade Failures

- Unsupported Kubernetes version
- Incompatible upgrade path
- Broken rancher-webhook
- SSL certificate issues
- Downstream cluster failing to reconnect

## Unsupported Kubernetes Version

It's important to note that Rancher is not compatible with every version of Kubernetes. For example, Rancher v2.7.9 only supports Kubernetes v1.23 through v1.26. So if you're running Kubernetes v1.22, you'll need to upgrade your cluster to v1.23 or higher before upgrading Rancher. There of course overlap between Rancher and Kubernetes versions, so you'll review the official [Support Matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/) to determine which versions are compatible.


Resolution:

Before upgrading Rancher, your should review the [Support Matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/). Then you should use that information to plan your Kubernetes upgrade. Once your cluster is running a supported version of Kubernetes, you can proceed with the Rancher upgrade.

## Incompatible Upgrade Path

Rancher does not support skipping versions when upgrading. For example, if you're running Rancher v2.5.x and want to upgrade to v2.7.x, you'll need to upgrade to v2.6.x, then you reach v2.7.X. If you try to skip versions, it may result in a failed upgrade and eradicate behavior. As skipping versions are not tested by Rancher.

Resolution:

You should review the [Upgrade Path](https://rancher.com/docs/rancher/v2.7/en/upgrades/upgrades/) documentation to determine the correct upgrade path for your Rancher version. Then you should use that information to plan your Rancher upgrade. Once you've determined the correct upgrade path, you can proceed with the Rancher upgrade. You can also review [Kubernetes Master Class: A Seamless Approach to Rancher & Kubernetes Upgrades](https://www.youtube.com/watch?v=d8kS8y8cLq4) video for more information. [Doc](https://github.com/mattmattox/Kubernetes-Master-Class/tree/main/rancher-k8s-upgrades)

## Broken rancher-webhook

The 

Example error message:

```bash
Error from server (InternalError): Internal error occurred: failed calling webhook "rancher.cattle.io.namespaces.create-non-kubesystem": failed to call webhook: Post "https://rancher-webhook.cattle-system.svc:443/v1/webhook/validation/namespaces?timeout=10s": Address is not allowed
```

Resolution:

Following the steps located at [KB 000020699](https://www.suse.com/support/kb/doc/?id=000020699) to resolve the issue.

## SSL Certificate Issues

When upgrading Rancher, if you don't set the ssl source to match the orginal ssl source, you may run into an issues with the downstream cluster failing to reconnect. For example, if you're using a manually generated certificate when you first installed Rancher, but then you upgrade Rancher and use a Let's Encrypt certificate. The downstream cluster will fail to reconnect after the upgrade is complete.

Example error message:

```bash
ERROR: Configured cacerts checksum (123...) does not match given --ca-checksum (456...)
```

Resolution:

Rerun your helm upgrade command and set the ssl source to match the original ssl source.

## Downstream Cluster Failing to Reconnect

When upgrading Rancher, the agents on the downstream clusters will automatically upgrade. However, if the agent upgrade fails, the downstream cluster will fail to reconnect to Rancher. This can be caused by a number of issues, including:

- Downstream Cluster is running an unsupported version of Kubernetes
- A change in the SSL certificate source for the Rancher API
- Bug [GH 37027](https://github.com/rancher/rancher/issues/37027)
