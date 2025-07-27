---
title: "Troubleshooting SMTP STARTTLS Connection Error: Base64 Decoding Error"
date: 2024-05-18
draft: false
tags: ["SMTP", "STARTTLS", "Base64 Decoding Error"]
categories:
- SMTP
- Email
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to resolve a common issue with SMTP STARTTLS connections encountering 'Base64 Decoding Error'."
more_link: "yes"
url: "/smtp-starttls-base64-decoding-error/"
---

Troubleshooting SMTP STARTTLS Connection Error: Base64 Decoding Error

<!--more-->

# [Troubleshooting SMTP STARTTLS Connection Error: Base64 Decoding Error](#troubleshooting-smtp-starttls-connection-error-base64-decoding-error)

As a Kubernetes Specialist, encountering errors in SMTP configurations can be frustrating. Recently, while setting up STARTTLS on exim4 in Debian 4.0 (Etch), I faced an intriguing issue. The system repeatedly reported a cryptic message:

```
TLS error on connection from _host_ (_ehlo_) [_ip_]
(cert/key setup: cert=/etc/ssl/certs/_whatever.crt_ key=/etc/ssl/private/_whatever.key_:
Base64 decoding error.
```

Even after running diagnostic tools like `gnutls-serv`, the root cause remained unclear.

After further investigation, I discovered that the error message was misleading. In reality, it wasn't a "Base64 decoding error" but a simple oversight - the passphrase hadn't been removed from the key file.

To rectify this issue, follow these steps:

```
cp foo.key foo.key.orig
openssl rsa -in foo.key.orig --out foo.key
```

By removing the passphrase from the key file, the SMTP STARTTLS connection error related to 'Base64 Decoding Error' should be resolved effectively.

---
