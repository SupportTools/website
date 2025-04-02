---
title: "RKE2 the Hard Way"
description: "Building an RKE2-like Kubernetes cluster from scratch, the hard way."
---

This training series will guide you through building a Kubernetes cluster from scratch, mirroring the features of RKE2 but without using any distribution-specific tools or shortcuts. We will manually configure each component to understand the underlying mechanisms.

## Parts

- [Part 1: Introduction and Prerequisites](/training/rke2-hard-way/01-introduction-prerequisites/)
- [Part 2: Certificate Authority and TLS Certificates](/training/rke2-hard-way/02-certificate-authority-tls-certificates/)
- [Part 3: Setting up containerd and kubelet](/training/rke2-hard-way/03-setting-up-containerd-and-kubelet/)
- [Part 4: Setting up etcd Cluster as Static Pods](/training/rke2-hard-way/04-setting-up-etcd-cluster/)
- [Part 5: Setting up kube-apiserver as Static Pods](/training/rke2-hard-way/05-setting-up-kube-apiserver/)
- [Part 6: Setting up kube-controller-manager and kube-scheduler as Static Pods](/training/rke2-hard-way/06-setting-up-kube-controller-manager-and-kube-scheduler/)
- [Part 7: Setting up kubelet and kube-proxy on Worker Nodes](/training/rke2-hard-way/07-setting-up-kubelet-and-kube-proxy/)
- [Part 8: Installing Cilium CNI](/training/rke2-hard-way/08-installing-cilium-cni/)
- [Part 9: Installing CoreDNS](/training/rke2-hard-way/09-installing-coredns/)
- [Part 10: Installing Ingress Nginx](/training/rke2-hard-way/10-installing-ingress-nginx/)
- [Part 11: Cluster Verification and Access](/training/rke2-hard-way/11-cluster-verification-and-access/)
