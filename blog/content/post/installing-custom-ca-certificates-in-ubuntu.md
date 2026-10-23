---
title: "Add a CA Certificate to Ubuntu: update-ca-certificates"
date: 2023-10-12T23:18:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Certificates", "Ubuntu", "update-ca-certificates", "curl", "OpenSSL"]
categories:
- "TLS & Certificates"
- Ubuntu
author: "Matthew Mattox - mmattox@support.tools"
description: "Copy the PEM CA file to /usr/local/share/ca-certificates/ as .crt and run sudo update-ca-certificates. Fixes curl (60) on Ubuntu 22.04, 24.04 and 26.04."
more_link: "yes"
quick_fix: |
  Copy the CA certificate (PEM format, one certificate per file, file name ending in `.crt`) into the local CA directory and rebuild the trust store:
  `sudo cp corp-root-ca.pem /usr/local/share/ca-certificates/corp-root-ca.crt && sudo update-ca-certificates`.
  Expect `1 added, 0 removed; done.` A file ending in `.pem` is ignored (`0 added`). To remove it later, delete the file and run `sudo update-ca-certificates --fresh`.
---

To trust a private or self-signed certificate authority on Ubuntu, put the CA certificate in `/usr/local/share/ca-certificates/` with a `.crt` extension and run `sudo update-ca-certificates`. That rebuilds `/etc/ssl/certs/ca-certificates.crt`, the bundle that curl, wget, git, apt, OpenSSL and most other tools on Ubuntu read. The procedure is identical on Ubuntu 22.04, 24.04 and 26.04. This guide covers getting the right certificate, the expected output, the three mistakes that make it silently do nothing, and the applications that ignore the system store.

<!--more-->

## The symptom

Before the CA is trusted, curl fails with exit code 60. The wording depends on the curl and OpenSSL version:

```text
# Ubuntu 24.04 (curl 8.5, OpenSSL 3.0)
curl: (60) SSL certificate problem: unable to get local issuer certificate

# Ubuntu 26.04 (OpenSSL 3.5)
curl: (60) SSL certificate OpenSSL verify result: unable to get local issuer certificate (20)
```

If the server also sends its root CA in the chain, the message is `self-signed certificate in certificate chain` (error 19) instead. Both mean the same thing: the issuing CA is not in the system trust store. Do not work around it with `curl -k`; add the CA.

## Step 1: Get the CA certificate, not the server certificate

You need the certificate of the CA that signed the server certificate, usually the root CA of your company, homelab or appliance. If you have it as a file, skip ahead. If not, pull the chain the server sends:

```bash
openssl s_client -connect app.example.internal:443 -servername app.example.internal -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' > served.pem
grep -c 'BEGIN CERTIFICATE' served.pem
```

Split it into one file per certificate and look at each one:

```bash
awk '/BEGIN CERTIFICATE/{n++} {print > ("cert-" n ".pem")}' served.pem
for f in cert-*.pem; do echo "== $f"; openssl x509 -in "$f" -noout -subject -issuer -ext basicConstraints; done
```

```text
== cert-1.pem
subject=CN = app.example.internal
issuer=CN = Corp Root CA
No extensions in certificate
== cert-2.pem
subject=CN = Corp Root CA
issuer=CN = Corp Root CA
X509v3 Basic Constraints: critical
    CA:TRUE
```

The one you want has `CA:TRUE`, and for a root CA the subject equals the issuer. If the server sends only its own certificate, ask the owner for the CA file; a certificate downloaded from the server is not proof of anything, so compare its fingerprint with a trusted source:

```bash
openssl x509 -in cert-2.pem -noout -fingerprint -sha256 -enddate
```

## Step 2: Make sure it is PEM, then install it

`update-ca-certificates` only reads PEM files (text starting with `-----BEGIN CERTIFICATE-----`). Windows exports and some appliances give you DER (binary). Convert it:

```bash
openssl x509 -inform der -in corp-root-ca.cer -out corp-root-ca.pem
```

Copy it with a `.crt` extension and update the store:

```bash
sudo cp corp-root-ca.pem /usr/local/share/ca-certificates/corp-root-ca.crt
sudo update-ca-certificates
```

Expected output:

```text
Updating certificates in /etc/ssl/certs...
rehash: warning: skipping ca-certificates.crt,it does not contain exactly one certificate or CRL
1 added, 0 removed; done.
Running hooks in /etc/ca-certificates/update.d...
done.
```

The `rehash: warning` line about `ca-certificates.crt` is normal on 24.04 and 26.04: the bundle file lives in the same directory as the per-certificate links and is skipped on purpose. The line that matters is `1 added`.

Subdirectories work too, which keeps things tidy when you manage several CAs: `/usr/local/share/ca-certificates/corp/root-ca.crt` is picked up the same way.

## Step 3: Verify

```bash
ls -l /etc/ssl/certs/corp-root-ca.pem
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.internal/
openssl s_client -connect app.example.internal:443 -servername app.example.internal </dev/null 2>/dev/null | grep 'Verify return code'
```

You should see a symlink `/etc/ssl/certs/corp-root-ca.pem -> /usr/local/share/ca-certificates/corp-root-ca.crt`, an HTTP status from curl instead of error 60, and `Verify return code: 0 (ok)` from OpenSSL. To confirm the CA is inside the bundle file:

```bash
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt cert-1.pem
```

## Why it did nothing: fix checklist

1. **The file ends in `.pem` or `.cer`.** `update-ca-certificates` only picks up `*.crt` in `/usr/local/share/ca-certificates/` and prints `0 added, 0 removed`. Rename it to `.crt`.
2. **The file is DER, not PEM.** Convert it with `openssl x509 -inform der` as above. A DER file renamed to `.crt` is not usable: the hash link step skips it.
3. **Several certificates in one `.crt` file.** The certificates are appended to `ca-certificates.crt`, but the hashed links in `/etc/ssl/certs` are skipped for that file (`rehash: warning: skipping bundle.pem,it does not contain exactly one certificate or CRL`). Programs that look up CAs by directory (`-CApath /etc/ssl/certs`, some Java and Python setups) will not find them. Split the bundle and install one certificate per file.
4. **You installed the server certificate instead of the CA.** It works only until the server certificate is renewed. Install the issuing root (or intermediate) CA.
5. **The application was already running.** Most programs read the CA bundle once at startup. Restart the service (Docker, containerd, nginx, your app) after updating.
6. **The application has its own trust store.** See the next section.

## Applications that ignore the system store

| Application | Where it gets CAs | What to do |
|---|---|---|
| curl, wget, git, apt, OpenSSL, Go, Ruby, PHP | `/etc/ssl/certs/ca-certificates.crt` | Nothing more; restart long-running processes |
| Docker daemon pulling images | System store, read at daemon start | `sudo systemctl restart docker`, or put the CA in `/etc/docker/certs.d/<registry>:<port>/ca.crt` |
| containerd and Kubernetes nodes | System store, read at start | Restart containerd on every node |
| Python `requests`, `pip` in a virtualenv | Often the bundled `certifi` file | `export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt` |
| Node.js | Its own compiled-in Mozilla bundle | `export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corp-root-ca.crt` |
| Java | `/etc/ssl/certs/java/cacerts` | Install `ca-certificates-java`; its hook in `/etc/ca-certificates/update.d/` refreshes the keystore |
| Chrome and Firefox | NSS databases in your home directory | Import in the browser, see [How to Get Chrome to Accept a Self-Signed Certificate](/post/chrome-accept-self-signed-certificate-guide/) |

## Removing a CA

Delete the file and run `update-ca-certificates` with `--fresh`:

```bash
sudo rm /usr/local/share/ca-certificates/corp-root-ca.crt
sudo update-ca-certificates --fresh
```

Without `--fresh`, the CA is dropped from `ca-certificates.crt` but the output still says `0 removed` and a dangling symlink stays behind in `/etc/ssl/certs`. `--fresh` clears all links and rebuilds them, so the directory matches the bundle again.

## Version and distro differences

- **Ubuntu 22.04, 24.04 and 26.04:** same directory, same command, same `.crt` rule. Differences are cosmetic: the curl error text changed with OpenSSL 3.5 on 26.04, and the `rehash` warning formatting differs slightly.
- **Debian:** identical to Ubuntu.
- **Docker images based on Ubuntu or Debian:** the `ca-certificates` package is not always installed. Use:

  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates
  COPY corp-root-ca.crt /usr/local/share/ca-certificates/
  RUN update-ca-certificates
  ```

- **Alpine:** same path and command (`apk add ca-certificates`, then `update-ca-certificates`).
- **RHEL, Fedora, Rocky:** different layout. Copy the file to `/etc/pki/ca-trust/source/anchors/` and run `sudo update-ca-trust`.

## FAQ

### Do I need to reboot after update-ca-certificates?

No. New processes see the change immediately. Long-running daemons that loaded the bundle at startup need a restart.

### Where is the Ubuntu CA bundle file?

`/etc/ssl/certs/ca-certificates.crt`. It is generated, so never edit it by hand; your changes disappear on the next `ca-certificates` package update.

### What is the difference between /usr/local/share/ca-certificates and /usr/share/ca-certificates?

`/usr/share/ca-certificates/` holds the Mozilla CA list from the `ca-certificates` package and is controlled by `/etc/ca-certificates.conf` (or `sudo dpkg-reconfigure ca-certificates`). `/usr/local/share/ca-certificates/` is for your own CAs, and every `.crt` file there is trusted automatically.

### How do I trust a CA for one command only?

Pass the file directly: `curl --cacert corp-root-ca.pem https://app.example.internal/`, `git -c http.sslCAInfo=corp-root-ca.pem clone ...`, or `openssl s_client -CAfile corp-root-ca.pem ...`. Nothing is changed system wide.

### How do I list the custom CAs that are installed?

`ls -l /usr/local/share/ca-certificates/` shows the source files, and `ls -l /etc/ssl/certs | grep /usr/local/share` shows which of them are linked into the store.

## Related guides

- [Create Your Own Certificate Authority (CA) for Homelab Environment](/create-certificate-authority-homelab/)
- [How to Become a Local CA and Sign Your Own SSL Certificates](/post/how-to-become-a-local-ca-and-sign-your-own-ssl-certificates/)
- [How to Get Chrome to Accept a Self-Signed Certificate](/post/chrome-accept-self-signed-certificate-guide/)
- [cURL Host Header: test HTTPS virtual hosts before DNS changes](/curl-host-header/)
