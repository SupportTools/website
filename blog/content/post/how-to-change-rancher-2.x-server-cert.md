+++
Categories = ["Rancher", "SSL"]
Tags = ["rancher", "ssl"]
date = "2021-03-01T11:10:00+00:00"
more_link = "yes"
title = "How to change the Rancher v2.x Server certificate to an externally created certificate."
+++

It's often necessary to migrate from a self-signed or LetsEncrypt certificate to an externally created certificate like DigiCert or Comodo in Rancher v2.x.

<!--more-->
# [Pre-requisites](#pre-requisites)

- kubectl access to the Rancher local cluster
- SSH access to one of the controlplane/master nodes on all downstream clusters.
- The certificate is stored as server.crt
- The private key is stored as tls.key
- The root CA is stored as root-ca.crt
- The intermediate CA is stored as intermediate-ca.crt
- All certificates should be in PEM format
Example:
```
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
```

# [Resolution](#resolution)

- Verify private key doesn't have a passphrase using the command listed below. If the following command asks for a passphrase, it is password-protected, and we must remove it.

```bash
openssl rsa -in tls.key -noout
```

- Remove the passphrase (skip this step if the previous command didn't ask for a passphrase):

```bash
mv tls.key tls-pass.key
openssl rsa -in tls-pass.key -out tls.key
Enter your passphrase here
```

- Create the certificate chain. If you have additional intermediate certs, please add them at this step.

**NB**: Order is important!

```bash
cat server.crt intermediate-ca.crt root-ca.crt > tls.crt
```

- Backup the current certificate:

```bash
kubectl -n cattle-system get secret tls-rancher-ingress -o yaml > tls-rancher-ingress-old.yaml
```

- Remove the current certificate:

```bash
kubectl -n cattle-system delete secret tls-rancher-ingress
```

- Install the new certificate:

```bash
kubectl -n cattle-system create secret tls tls-rancher-ingress \
--cert=tls.crt \
--key=tls.key
```

- Get the current values for helm deployment for Rancher

```bash
helm get values rancher -n cattle-system -o yaml > values.yaml
```

- Add/Edit `ingress.tls.source` in `values.yaml` to be `ingress.tls.source=secret`

- Update the Rancher deployment.

**NB**: You should change the version flag to match your current Rancher version.

```bash
helm upgrade rancher rancher-latest/rancher \
  --namespace cattle-system \
  -f values.yaml \
  --version=2.5.5
```

- Run the following command to verify the new certificate. (Replace Rancher with your Rancher URL):

```bash
curl -k -v https://Rancher 2>&1 | awk 'BEGIN { cert=0 } /^\* SSL connection/ { cert=1 } /^\*/ { if (cert) print }'
```

- Example output:

```plaintext
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
* ALPN, server did not agree to a protocol
* Server certificate:
*  subject: OU=Domain Control Validated; CN=*.rancher.tools
*  start date: Jul  2 00:42:01 2019 GMT
*  expire date: May  2 00:19:41 2020 GMT
*  issuer: C=BE; O=GlobalSign nv-sa; CN=AlphaSSL CA - SHA256 - G2
*  SSL certificate verify ok.
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
* TLSv1.3 (IN), TLS handshake, Newsession Ticket (4):
* old SSL session ID is stale, removing
* Mark bundle as not supporting multiuse
* Connection #0 to host lab.rancher.tools left intact
```

**NB**: Some browsers will cache the certificate. So you might to close the browser and reopen it to get the new certificate. [How to clear the SSL state in a browser](https://a2hosting.com/kb/getting-started-guide/internet-and-networking/clearing-a-web-browsers-ssl-state).

- Use the cluster-agent-tools to update all the cluster agents with the new ca checksum.
https://github.com/rancherlabs/support-tools/tree/master/cluster-agent-tool

**NB**: You will need to do this for each cluster managed by Rancher.

# [Rollback](#rollback)
- Remove the new certificate:

```bash
kubectl -n cattle-system delete secret tls-rancher-ingress
```

- Re-install the old certificate:

```bash
kubectl -n cattle-system apply -f tls-rancher-ingress-old.yaml
```

- Then, follow the same steps as the installation.
