---
title: "Rotating RKE2 Certificates Before Expiration: A Necessary Practice"
date: 2024-02-28T10:00:00-05:00
draft: false
tags: ["RKE2", "Kubernetes", "Certificate Management"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools."
description: "Understand the importance of rotating RKE2 certificates before their one-year expiration to ensure continuous cluster security."
more_link: "no"
---

In the lifecycle of a Kubernetes cluster managed by RKE2, one critical maintenance task stands out for its importance in ensuring the security and reliability of the cluster: certificate rotation. This blog post delves into the significance of rotating RKE2 certificates before they expire after one year, outlining the necessary steps to prevent potential security vulnerabilities or service interruptions.

<!--more-->

## [Understanding Certificate Expiration in RKE2](#understanding-certificate-expiration-in-rke2)

RKE2, like many secure systems, uses certificates to establish trust and secure communications between the various components of a Kubernetes cluster. These certificates have a limited validity period, typically set to one year by default. When a certificate expires, any communication or authentication that relies on it will fail, potentially leading to service outages or, worse, compromising the security of your cluster.

## [The Importance of Preemptive Certificate Rotation](#the-importance-of-preemptive-certificate-rotation)

Waiting for certificates to expire before taking action is risky and can lead to unplanned downtime and emergency maintenance. Proactively rotating certificates:

- **Ensures Continuous Operation:** By replacing certificates before expiring, you avoid cluster operations interruptions.
- **Enhances Security:** Regular rotation limits the window of opportunity for any compromised certificates to be exploited.
- **Meets Compliance Requirements:** Many regulatory standards require periodic rotation of security credentials, including certificates.

## [Steps for Rotating RKE2 Certificates](#steps-for-rotating-rke2-certificates)

1. **Schedule the Rotation:** Plan the certificate rotation well before expiration. Consider automating notifications to alert you when certificates are nearing their expiry.

2. **Perform a Cluster Backup:** Always back up your cluster before performing any significant changes, including certificate rotation. This ensures you can recover your cluster to a working state in case of any issues.

3. **Initiate the Rotation:** To rotate the certificates, you can restart the RKE2 server processes across your cluster, which will automatically generate new certificates:

### [Standalone RKE2](#standalone-rke2)

1. You need SSH access to all RKE2 controller nodes.

2. Before starting, ensure an ETSD snapshot and a backup of the /var/lib/rancher/rke2/server/tls directory.

```bash
rke2 etcd snapshot --name pre-rotate-snapshot
tar -czvf /var/lib/rancher/rke2/server/tls/pre-rotate-tls.tar.gz /var/lib/rancher/rke2/server/tls
```

Note: Repeat on all master nodes.

3. Rotate the certificates by running the following command on each master node:

```bash
systemctl stop rke2-server
rke2-killall.sh
rke2 certificate rotate
systemctl start rke2-server
```

Note: Repeat for all master nodes in the cluster in a rolling fashion.

4. Update certificates on all worker nodes:

Note: Worker nodes should automatically update their certificates after the master nodes have been rotated, which might take a few minutes. If, after 15 minutes, the certificates have not been updated, you can manually update the certificates by running the following command on each worker node:

```bash
systemctl stop rke2-agent
rke2-killall.sh
systemctl start rke2-agent
```

### [RKE2 deploy via Rancher](#rke2-deploy-via-rancher)

Offical documentation: [RKE2 - Rotate Certificates](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/manage-clusters/rotate-certificates)

1. Log in to the Rancher UI and navigate to the RKE2 cluster you want to rotate certificates for.

2. Click on the cluster name to open the cluster details page.

3. Click on the action menu (three vertical dots) in the upper right corner and select Rotate Certificates. Select the first option; IE Rotate all Service Certificates.

4. Click Save.

5. The cluster will now rotate the certificates. This process can take a few minutes to complete.

## [Monitoring RKE2 Certificate Expiration](#monitoring-rke2-certificate-expiration)

To avoid the risk of certificates expiring without your knowledge, you should monitor their expiration dates. I recommand x509-certificate-exporter, a Prometheus exporter that collects and exports x509 certificate information. You can use this exporter to monitor the expiration dates of RKE2 certificates and set up alerts to notify you when certificates are nearing their expiration.

Please refer to this post for more information: [Monitoring RKE2 Certificate Expiration with x509-certificate-exporter](https://support.tools/post/x509-certificate-exporter/)

## [Conclusion](#conclusion)

Rotating RKE2 certificates before their expiration is a necessary practice to ensure the security and reliability of your Kubernetes cluster. By understanding the importance of preemptive certificate rotation and following the necessary steps, you can avoid potential security vulnerabilities and service interruptions. Additionally, monitoring the expiration dates of your certificates will help you stay ahead of any potential issues and maintain the continuous operation of your cluster.