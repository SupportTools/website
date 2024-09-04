---
title: "All Required Domain Controller Ports"  
date: 2024-10-14T19:26:00-05:00  
draft: false  
tags: ["Domain Controller", "Ports", "Active Directory", "Networking"]  
categories:  
- Networking  
- Active Directory  
- Security  
author: "Matthew Mattox - mmattox@support.tools."  
description: "A comprehensive list of all required ports for Domain Controllers to function properly in Active Directory environments."  
more_link: "yes"  
url: "/required-domain-controller-ports/"  
---

In an Active Directory (AD) environment, **Domain Controllers (DCs)** must communicate over a variety of ports to provide services such as authentication, replication, and management. Properly configuring network firewalls to allow these ports is critical to ensure the domain operates smoothly without disruptions.

This post outlines all the required ports for Domain Controllers to function correctly in a secure and reliable AD environment.

<!--more-->

### Key Services and Associated Ports

A Domain Controller performs several critical functions, including Kerberos authentication, LDAP queries, replication, and more. Below is a list of key services and the ports required for them:

#### 1. **Kerberos Authentication (UDP/TCP 88)**

Kerberos is the authentication protocol used by Active Directory to verify the identity of users and services. It uses port **88** for both UDP and TCP.

- **Service**: Kerberos
- **Port**: UDP/88, TCP/88
- **Description**: Used for authentication requests.

#### 2. **LDAP (TCP/UDP 389)**

The Lightweight Directory Access Protocol (LDAP) is used for querying and modifying directory services. It operates on port **389** for unencrypted connections.

- **Service**: LDAP
- **Port**: TCP/389, UDP/389
- **Description**: Used for directory queries and modifications.

#### 3. **LDAP over SSL (LDAPS) (TCP 636)**

LDAP over SSL (LDAPS) is used when securing LDAP communications with SSL encryption. This ensures the confidentiality and integrity of LDAP queries.

- **Service**: LDAPS
- **Port**: TCP/636
- **Description**: Secured LDAP communications over SSL.

#### 4. **Global Catalog (TCP 3268, 3269)**

The Global Catalog (GC) is a distributed data repository used by AD for searching objects across domains. It runs on port **3268** for unencrypted traffic and **3269** for encrypted (SSL) traffic.

- **Service**: Global Catalog
- **Port**: TCP/3268 (unencrypted), TCP/3269 (SSL)
- **Description**: Provides search functionality across multiple domains in the forest.

#### 5. **SMB over TCP (TCP 445)**

Server Message Block (SMB) is used for file sharing and other communications in a Windows environment. Domain Controllers use SMB for various administrative tasks, including Group Policy replication.

- **Service**: SMB
- **Port**: TCP/445
- **Description**: File sharing and other administrative tasks.

#### 6. **RPC Endpoint Mapper (TCP 135)**

The Remote Procedure Call (RPC) Endpoint Mapper listens on port **135** and helps clients locate the service they need, such as Active Directory replication and management tasks.

- **Service**: RPC Endpoint Mapper
- **Port**: TCP/135
- **Description**: Used to map RPC services and endpoints.

#### 7. **DNS (TCP/UDP 53)**

Domain Name System (DNS) is critical in AD environments for resolving domain names to IP addresses. DNS traffic typically operates on port **53**.

- **Service**: DNS
- **Port**: TCP/53, UDP/53
- **Description**: Used for DNS queries and zone transfers.

#### 8. **Replication (RPC over TCP 135, 49152-65535)**

AD replication uses **RPC** over TCP, with the RPC Endpoint Mapper assigning the port dynamically between **49152** and **65535**.

- **Service**: AD Replication
- **Port**: TCP/135, Dynamic ports 49152-65535
- **Description**: Active Directory replication services between Domain Controllers.

#### 9. **NetBIOS (UDP 137, 138; TCP 139)**

NetBIOS is an older protocol that is still required for some legacy services and communication, particularly in environments running older systems.

- **Service**: NetBIOS Name Service, Datagram Service, Session Service
- **Port**: UDP/137 (Name Service), UDP/138 (Datagram Service), TCP/139 (Session Service)
- **Description**: NetBIOS over TCP/IP services.

#### 10. **NTDS RPC (TCP 135)**

This port is used for Active Directory management and replication over **RPC** (Remote Procedure Call). It is required for Domain Controllers to communicate with each other.

- **Service**: NTDS RPC
- **Port**: TCP/135
- **Description**: Used for AD replication and management tasks.

### Optional Ports for Additional Services

If your Domain Controller is also providing additional services, such as Windows Time Service (W32Time) or certificate services, you will need to open the following ports:

#### 11. **W32Time (UDP 123)**

The Windows Time Service (W32Time) ensures that all systems in an Active Directory forest have synchronized time. Time synchronization is crucial for Kerberos authentication.

- **Service**: W32Time
- **Port**: UDP/123
- **Description**: Time synchronization across the domain.

#### 12. **Certificate Services (TCP 443, 9389)**

If your Domain Controller is also hosting a Certification Authority (CA) for issuing certificates, ports **443** (HTTPS) and **9389** are required for certificate enrollment.

- **Service**: Certificate Services
- **Port**: TCP/443, TCP/9389
- **Description**: Used for Certificate Authority services.

### Conclusion

For proper functionality, Domain Controllers must communicate over specific ports to handle tasks such as authentication, replication, and DNS resolution. Ensuring that these ports are open and accessible across your network will prevent issues with AD services, such as authentication failures or replication delays.

While it's essential to secure these ports using firewalls and access controls, understanding which ports are required is a critical first step in maintaining a healthy Active Directory environment.
