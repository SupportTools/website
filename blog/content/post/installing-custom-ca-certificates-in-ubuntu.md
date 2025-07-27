---
title: "Installing Custom CA Certificates on Ubuntu 22.04"
date: 2023-10-12T23:18:00-05:00
draft: false
tags: ["Certificates", "Ubuntu"]
categories:
- Certificates
- Ubuntu
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide on installing custom CA certificates on Ubuntu 22.04."
more_link: "yes"
---

## Installing Custom CA Certificates on Ubuntu 22.04

If you are dealing with a server that uses self-signed SSL certificates, you may encounter issues with client utilities like `curl`, which may refuse to work without using the `-k` or `--insecure` option. Here's a step-by-step guide on how to install custom CA certificates on an Ubuntu 22.04 system (similar steps apply to Ubuntu 20.04 and 18.04):

- **Combine SSL Certificates:** Start by combining the SSL certificate chain and the SSL certificate into a single file. You can download both certificates from your server by accessing `https://your-server-name`. Ensure that the file extension for this combined certificate file is `.crt`.

- **Copy to CA Certificates Directory:** Copy the `.crt` file you created in the previous step to the `/usr/local/share/ca-certificates/` directory.

- **Update CA Certificates:** Run the following command to update the CA certificates on your system:

```bash
sudo update-ca-certificates
```

This command will update the file `/etc/ssl/certs/ca-certificates.crt` with the contents of your `.crt` file. After this, utilities like `curl` and other command-line tools that rely on CA certificates from `/etc/ssl/certs` should work without issues.

Your Ubuntu 22.04 system should be configured to use your custom CA certificates for secure connections.
