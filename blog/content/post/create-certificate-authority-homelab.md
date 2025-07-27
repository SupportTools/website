---
title: "Create Your Own Certificate Authority (CA) for Homelab Environment"  
date: 2024-09-26T19:26:00-05:00  
draft: false  
tags: ["Certificate Authority", "CA", "TLS", "Homelab", "Security"]  
categories:  
- Security  
- Homelab  
- TLS  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to create your own Certificate Authority (CA) for your homelab environment and issue TLS certificates for your internal systems."  
more_link: "yes"  
url: "/create-certificate-authority-homelab/"  
---

Setting up a custom Certificate Authority (CA) for your homelab environment allows you to issue TLS certificates for internal systems, providing encrypted connections and authentication without relying on external CAs. In this post, we’ll walk through the steps to create your own CA, generate certificates, and install them for use in your homelab.

<!--more-->

### Why Create Your Own Certificate Authority?

In a homelab environment, using self-signed certificates can lead to trust issues with browsers and services that require secure communication. By creating your own CA, you can manage trust within your internal network and issue certificates for your services (e.g., web servers, APIs) that are trusted across your systems.

Creating a CA also helps you practice certificate management, a valuable skill in real-world production environments.

### Step 1: Install OpenSSL

OpenSSL is a popular tool for working with certificates and cryptographic materials. If OpenSSL is not already installed, you can install it using the following command on most Linux distributions:

```bash
sudo apt-get update
sudo apt-get install openssl
```

For RedHat-based systems:

```bash
sudo yum install openssl
```

### Step 2: Create the Root Certificate Authority

The first step in setting up your CA is to create the root certificate that will be used to sign all other certificates.

#### 1. **Create a Private Key for the CA**

```bash
openssl genrsa -des3 -out ca.key 4096
```

This generates a 4096-bit RSA private key for the CA, secured with a password.

#### 2. **Create a Self-Signed Root Certificate**

Use the CA private key to generate a self-signed root certificate:

```bash
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt
```

You’ll be prompted to fill in information such as the country, organization, and common name. For the common name, use a name that clearly identifies this as your root CA, such as `Homelab Root CA`.

The `-days 3650` flag sets the validity of the certificate to 10 years. Adjust the number of days as needed.

### Step 3: Create Certificates for Internal Services

Once the root CA is created, you can use it to sign certificates for your internal services.

#### 1. **Create a Private Key for the Service**

Generate a private key for the service (e.g., a web server):

```bash
openssl genrsa -out server.key 2048
```

#### 2. **Generate a Certificate Signing Request (CSR)**

Create a CSR that will be signed by the root CA:

```bash
openssl req -new -key server.key -out server.csr
```

When prompted, ensure that the common name (CN) matches the fully qualified domain name (FQDN) of the service (e.g., `myapp.homelab.local`).

#### 3. **Sign the CSR with the Root CA**

Sign the CSR using your root CA to generate the service certificate:

```bash
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -sha256
```

This generates a certificate (`server.crt`) that is valid for 1 year and signed by your root CA. The `CAcreateserial` flag generates a new serial number for the certificate.

### Step 4: Install the Root CA on Trusted Devices

To avoid browser and system warnings about untrusted certificates, you’ll need to install the root CA certificate (`ca.crt`) on all trusted devices.

#### For Linux

Copy the root certificate to the appropriate directory and update the CA certificates:

```bash
sudo cp ca.crt /usr/local/share/ca-certificates/homelab-ca.crt
sudo update-ca-certificates
```

#### For Windows

1. Open **mmc.exe** and add the **Certificates** snap-in.
2. Select **Trusted Root Certification Authorities** > **Certificates**.
3. Right-click and choose **Import**, then follow the prompts to import `ca.crt`.

#### For macOS

1. Open **Keychain Access**.
2. Drag and drop the `ca.crt` file into the **System** keychain.
3. Set the certificate to **Always Trust**.

### Step 5: Configure Services to Use the Signed Certificate

For any internal service (e.g., NGINX, Apache), configure it to use the signed certificate (`server.crt`) and private key (`server.key`).

#### Example for NGINX

```nginx
server {
    listen 443 ssl;
    server_name myapp.homelab.local;

    ssl_certificate /etc/nginx/ssl/server.crt;
    ssl_certificate_key /etc/nginx/ssl/server.key;

    location / {
        # Your app configuration
    }
}
```

After updating the configuration, restart the service:

```bash
sudo systemctl restart nginx
```

### Step 6: Verify the Certificate

Once the service is configured with the signed certificate, you can test it by accessing the service from a browser. If everything is configured correctly and the root CA is trusted, the browser should establish a secure connection without warnings.

You can also use `openssl` to verify the certificate chain:

```bash
openssl verify -CAfile ca.crt server.crt
```

This command should return `server.crt: OK` if the certificate chain is valid.

### Final Thoughts

Creating your own Certificate Authority for a homelab environment is a great way to practice certificate management and secure internal communications. With your CA in place, you can issue trusted certificates for all your internal services, ensuring encrypted connections and eliminating browser warnings.
