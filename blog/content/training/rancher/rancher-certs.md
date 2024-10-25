---
title: "Rancher Certs"
date: 2022-04-29T02:03:30-05:00
draft: false
tags: ["rancher", "certs", "training"]
categories:
- rancher
author: "Matthew Mattox - mmattox@support.tools"
description: "Rancher Certificates"
---

## What are SSL Certs?
Generally referred to as a cert or certificate, an SSL certificate authenticates a website's identity and enables an encrypted connection. A web browser and a server create an encrypted link using Secure Sockets Layer or SSL.

In short: SSL ensures the data exchanged between two systems is kept private. When you see a padlock icon next to the URL in the address bar, SSL protects the connection between you and the website you are visiting.

## How do SSL certificates work?
SSL encrypts all data transferred between websites and their visitors or between two systems so that third parties cannot read it. The encryption algorithm scrambles data during transmission, preventing hackers from reading it. Information such as names, addresses, credit card numbers, or other financial information may be contained. Rancher uses SSL to secure its API, including usernames, passwords, secrets, and communication with the downstream cluster.

Here's how it works:

- Browsers/cattle agents connect to the Ingress server, which we'll refer to as the server for purposes of this section.
- The browser/cattle agent requests that the server identify itself.
- In response, the server sends a copy of its SSL chain certificate to the browser or cattle agent.
It checks whether the browser/cattle agent trusts the SSL chain certificate. If it does, the connection continues; otherwise, an x509 error will be returned.
- The browser/cattle agent will acknowledge that it trusts the certificate by sending a signal back to the server.
- When an SSL encrypted session is initiated, the server returns a digitally signed acknowledgment.
- Client/server data is exchanged with a session key between the browser and cattle agent.

Often referred to as an "SSL handshake". Although it sounds like an extensive process, they are completed within milliseconds.

## What is the difference between Rancher and RKE/k8s certs?
The Rancher certs are used to secure the API, and the RKE/k8s certs are used to secure the cluster. These two are different things and are not interchangeable. If your Rancher cert is expired, rotating your RKE/k8s certs will not fix it.

By default Rancher uses an ingress to expose the API and UI to externally in the same way that most other HTTP(s) applications hosted in Kubernetes would be exposed. RKE/k8s certs are used to secure the cluster components like etcd, kube-apiserver, kube-controller-manager, and kube-scheduler.

## Installing Rancher certs
Rancher can, of course, be configured in a variety of ways for the cert provider. You can find more information on configuring Rancher certs in the Rancher [documentation](https://rancher.com/docs/rancher/v2.6/en/installation/install-rancher-on-k8s/#3-choose-your-ssl-configuration).

In this section, we will cover the following types of certs:
  - Self-signed certs
  - Lets Encrypt certs
  - Privately signed certs
  - Publicly signed certs
  - External TLS Termination

### Self-signed certs
Self-signed certs are the easiest way to get started with Rancher and are the default option. The critical thing to note is that a trusted CA does not sign the self-signed certs. This means that the browser will not trust the self-signed certs.

The process for creating a self-signed cert is as follows:
- Installing the cert-manager Helm chart using the process outlined in the [Rancher documentation](https://rancher.com/docs/rancher/v2.6/en/installation/install-rancher-on-k8s/#4-install-cert-manager).

Example helm install command:
```bash
helm install rancher rancher-latest/rancher \
  --namespace cattle-system \
  --set hostname=rancher.my.org \
  --set ingress.tls.source=rancher \
  --set bootstrapPassword=admin
```

Note: `ingress.tls.source=rancher` is the default option. So if you don't specify `ingress.tls.source` in your Helm install, Rancher will default to using self-signed certs.

At this point, Rancher will create a new root CA and a self-signed cert. The cert-manager handles this process with Rancher only making the cluster issuer and certificate request.

If you need to troubleshoot this process, you can check the logs for the cert-manager pod.

```bash
kubectl get pods --namespace cert-manager

NAME                                       READY   STATUS    RESTARTS   AGE
cert-manager-5c6866597-zw7kh               1/1     Running   0          2m
cert-manager-cainjector-577f6d9fd7-tr77l   1/1     Running   0          2m
cert-manager-webhook-787858fcdb-nlzsq      1/1     Running   0          2m
```

The self-signed certs should be good for one year, and the cert-manager should automatically rotate the certs.

If you are having cert-manager renewal issues. You can find more information in the [Cert-Manager FAQ](https://cert-manager.io/v1.2-docs/faq/#what-happens-if-a-renewal-is-doesnt-happen-due-to-issues-will-it-be-tried-again-after-sometime) and [Cert-Manager documentation](https://cert-manager.io/docs/usage/certificate/#renewal).

Note: Self-signed certs are not recommended for production use.

### Lets Encrypt certs
Lets Encrypt is a free service that lets you get free SSL certificates. The process is that cert-manager will use the Lets Encrypt ACME (Automated Certificate Management Environment) server to verify the hostname and issue a certificate.

Rancher creates the [Issuer object](https://github.com/rancher/rancher/blob/release/v2.6/chart/templates/issuer-letsEncrypt.yaml) with configuration for Let's Encrypt, cert-manager then watches for ingress objects in the `cattle-system` namespace to perform the signing request and challenge. The [HTTP-01 challenge](https://cert-manager.io/docs/tutorials/acme/http-validation/) is used to verify the hostname. This means that port 80 will need to be open to the public internet and accessible to anyone, the Rancher hostname must also be resolvable publicly.

This is recommended for production use when the Rancher server is hosted publicly, like in a public cloud like AWS, DigitalOcean, etc.

The process for creating a Lets Encrypt cert is as follows:
- Installing the cert-manager Helm chart using the process outlined in the [Rancher documentation](https://rancher.com/docs/rancher/v2.6/en/installation/install-rancher-on-k8s/#4-install-cert-manager).
During the Rancher install process, you will need to set the helm option `ingress.tls.source=letsEncrypt`.
- It's also vital that you set the helm option `letsEncrypt.email` to your email address or a support mailbox monitored by your team as is how Lets Encrypt will alert you if the certificate is going to expire or if it is going to be revoked.

Example helm install command:
```bash
helm install rancher rancher-latest/rancher \
  --namespace cattle-system \
  --set hostname=rancher.my.org \
  --set bootstrapPassword=admin \
  --set ingress.tls.source=letsEncrypt \
  --set letsEncrypt.email=me@example.org
```

At this point, you should be able to access the Rancher UI without a certificate error.

If you need to troubleshoot this process, you can check the logs for the cert-manager pod:

```bash
kubectl get pods --namespace cert-manager

NAME                                       READY   STATUS    RESTARTS   AGE
cert-manager-5c6866597-zw7kh               1/1     Running   0          2m
cert-manager-cainjector-577f6d9fd7-tr77l   1/1     Running   0          2m
cert-manager-webhook-787858fcdb-nlzsq      1/1     Running   0          2m
```

### Publicly signed certs
Publicly signed certs are commonly used in production environments. The process is that the user will handle creating the certificate and working with the public root CA like Digicert, Thawte, etc., to sign the certificate. If you need details on creating a publicly signed cert, you can find more information [here](https://www.digicert.com/kb/csr-creation.htm).

After the certificate is signed, you should receive a certificate for the root CA, a certificate chain, and a private key. **Note**: There are two main formats for the certificate, binary and base64. The base64 format is the one we want. If you want to learn more about this, I recommend reading [this guide](https://www.ssls.com/knowledgebase/what-are-certificate-formats-and-what-is-the-difference-between-them/). 

The other important piece is that the private key should not have a password/passphrase. If you need this, I would recommend using a tool to remove the passphrase, like [OpenSSL](https://www.openssl.org/docs/man3.0/man1/openssl.html) and the command `openssl RSA -in [original.key] -out [new.key]`.


To use the certificate with Rancher, we need the following files:
- The certificate file (tls.crt)
This file should be in the PEM format and include the complete certificate chain.

Example:
```
-----BEGIN CERTIFICATE-----
This server certificate is tied to the Rancher hostname like `rancher.example.com` but can be linked to a wildcard domain name like `*.example.com`.
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
This is the intermediate certificate. This is generally bundled with the certificate or found on the certificate authority website.
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
This is the root certificate. This is generally bundled with the certificate or found on the certificate authority website.
-----END CERTIFICATE-----
```

- The private key file (tls.key)
This file should be in the PEM format and should not have a password/passphrase.

Example:
```
-----BEGIN RSA PRIVATE KEY-----
This is the private key. This is generally created during the certificate request process and should not be shared with anyone as the secret is what makes the certificate secure.
-----END RSA PRIVATE KEY-----
```

Once we have the files ready, we can create the tls secret with the following command:
```bash
kubectl -n cattle-system create secret tls tls-rancher-ingress \
  --cert=tls.crt \
  --key=tls.key
```

At this point, we need to configure Rancher to use the TLS secret. This is done by setting the helm value `ingress.tls.source=secret`.

Example helm install command:
```bash
helm install rancher rancher-latest/rancher \
  --namespace cattle-system \
  --set hostname=rancher.my.org \
  --set bootstrapPassword=admin \
  --set ingress.tls.source=secret
```

At this point, you should be able to access the Rancher UI without a certificate error.

If you need to renew the certificate, you can run the following commands to back up the current certificate and key. Then import the new certificate and key.

- Backup the current certificate and key:
```bash
kubectl -n cattle-system get secret tls-rancher-ingress -o yaml > rancher-ingress-tls.yaml
```

- Remove the current certificate and key:
```bash
kubectl -n cattle-system delete secret tls-rancher-ingress
```

- Import the new certificate and key:
```bash
kubectl -n cattle-system create secret tls tls-rancher-ingress \
  --cert=tls.crt \
  --key=tls.key
```

Note: It is imperative to back up the current certificate and key before importing the new certificate and key. If you don't, you will lose the existing certificate and key. Also, it is crucial not to change the root certificate during this process. For example, you are switching from Digicert to Thawte or vice versa. If you need to switch, please follow the steps listed below under [When migrating to/from a private CA](#switching-between-cert-providers).


### Privately signed certs
Privately signed certs are commonly used in enterprise environments where customers run their own private root CA. This private root CA is generally trusted by the customer, and the customer is responsible for signing the certificate. But it is important to note that the private root CA is not trusted by the browser by default; some enterprise environments may have a policy that pushes the private root CA to all their users' workstations.

I recommend that you look at this [guide](https://virtuallythere.blog/2018/04/24/making-things-a-bit-more-secure-part-1/) to learn more about how to set up a Windows CA server and how to configure your browser to trust the private root CA. It is essential to understand that by default, most containers will not trust the private root CA, including the Rancher servers pods and the Rancher agents. To fix this, you will need to add the private root CA as a secret to the Rancher server deployment using the process listed below.

To use the certificate with Rancher, we need the following files:
- The certificate file (tls.crt)
This file should be in the PEM format and include the complete certificate chain.

Example:
```
-----BEGIN CERTIFICATE-----
This is a server certificate tied to the Rancher hostname like `rancher.example.com` but can be linked to a wildcard domain name like `*.example.com`.
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
This is the intermediate certificate. This is generally bundled with the certificate or found on the certificate authority website.
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
This is the root certificate. This is generally bundled with the certificate or found on the certificate authority website.
-----END CERTIFICATE-----
```

- The private key file (tls.key)
This file should be in the PEM format and should not have a password/passphrase.

Example:
```
-----BEGIN RSA PRIVATE KEY-----
This is the private key. This is generally created during the certificate request process and should not be shared with anyone. As the private is what makes the certificate secure.
-----END RSA PRIVATE KEY-----
```

- The root CA file (cacerts.pem)
This file should be in the PEM format and only include the root certificate. The server and intermediate certificates should not be included.

Once we have the certificate files ready, we can create the secrets with the following commands:
```bash
kubectl -n cattle-system create secret tls tls-rancher-ingress \
  --cert=tls.crt \
  --key=tls.key

kubectl -n cattle-system create secret generic tls-ca \
  --from-file=cacerts.pem=./cacerts.pem
```

At this point, we need to configure Rancher to use the TLS secret. This is done by setting the helm value `ingress.tls.source=secret`, additionally `--set privateCA=true` needs to be set.

Example helm install command:
```bash
helm install rancher rancher-latest/rancher \
  --namespace cattle-system \
  --set hostname=rancher.my.org \
  --set bootstrapPassword=admin \
  --set ingress.tls.source=secret \
  --set privateCA=true
```

At this point, you should be able to access the Rancher UI without a certificate error.

If you need to renew the certificate, you can run the following commands to back up the current certificate and key. Then import the new certificate and key.

- Backup the current certificate and key:
```bash
kubectl -n cattle-system get secret tls-rancher-ingress -o yaml > rancher-ingress-tls.yaml
```

- Remove the current certificate and key:
```bash
kubectl -n cattle-system delete secret tls-rancher-ingress
```

- Import the new certificate and key:
```bash
kubectl -n cattle-system create secret tls tls-rancher-ingress \
  --cert=tls.crt \
  --key=tls.key
```

### External TLS Termination
Rancher can be configured to use an external TLS termination service. This is useful for example if you are running Rancher in a private network and want to use a third-party TLS termination service. Which means that an external server/load balancer will be responsible for providing the TLS certificate. This means that the Rancher ingress will be configured to only listen on port 80. Be aware that clients that are allowed to connect directly to the Rancher cluster will not be encrypted.

To configure Rancher to use an external TLS termination service, we need to set the following helm value `ingress.tls.source=external`.

Example helm install command:
```bash
helm install rancher rancher-latest/rancher \
  --namespace cattle-system \
  --set hostname=rancher.my.org \
  --set bootstrapPassword=admin \
  --set ingress.tls.source=external
```

At this point, you would need to configure the external load balancer to provide the TLS certificate.

Note: If you are using a Private CA signed certificate, add `--set privateCA=true` and see [Adding TLS Secrets - Using a Private CA Signed Certificate](https://rancher.com/docs/rancher/v2.6/en/installation/resources/tls-secrets/) to add the CA cert for Rancher.

You can find more information about external TLS termination services [here](https://rancher.com/docs/rancher/v2.6/en/installation/install-rancher-on-k8s/chart-options/#external-tls-termination).

## Fixing expired certs for Rancher
One of the classic issues that Rancher users face is that their certificate is expired. This can cause downstream clusters to fail to connect to Rancher. Leaving the downstream clusters inaccessible, leading to a lot of issues.

To fix this issue:
Renew the certificate, which will change based on the cert provider step, which can be found above for each cert provider, with the general process being to backup the current certificate and key.
Delete the current certificate and key.
Import the new certificate and key.
The cattle agents should auto-reconnect to Rancher after a min or two.

Note: If you are running Rancher in single-node mode, you must restart the Rancher server pod to renew the certificate. Also, if you are running older versions of Rancher, you will need to follow the steps outlined in the [GH-26984](https://github.com/rancher/rancher/issues/26984).

## When migrating between cert types
Suppose you want to switch certs types. For example, you are switching from self-signed to a Publicly signed cert. You'll need to follow the documented [Update CA Cert](https://rancher.com/docs/rancher/v2.6/en/installation/resources/update-rancher-cert/) for updating the certificate and cacerts.

Follow the steps above for the new cert provider to install the new certificate and key.

At this point, you should be able to access the Rancher UI without a certificate error, but the downstream clusters will not be able accessible until they are updated. But the issue becomes how Rancher can update the agents if Rancher can't connect to them. So we need to follow work through one of the methods located in the [Updating a Private CA Certificate](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/resources/update-rancher-certificate#4-reconfigure-rancher-agents-to-trust-the-private-ca) to update the agents.

You should see the cluster reconnect in Rancher after a few minutes. Depending on the method you may need to repeat the steps to update the other downstream clusters.

Note: The downstream clusters will be in a "Disconnected" state during this process. This is expected behavior. Your application should have no idea this is happening. With the main impact being the cluster management via the Rancher UI and kubectl, access to the cluster will be offline until the cluster is reconnected. So it is recommended to disable all CI/CD jobs during this process. In addition, you should also look into Authorized Cluster Endpoint (ACE) to allow you to configure kubectl to bypass the Rancher API and directly access the cluster. This is an excellent way to handle the case where Rancher is down, and you want to be able to manage your applications. You can find out more about ACE [here](https://rancher.com/docs/rancher/v2.6/en/cluster-admin/cluster-access/ace/).