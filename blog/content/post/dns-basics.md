---
title: "DNS Basics"
date: 2022-07-11T19:26:00-05:00
draft: false
tags: ["DNS"]
categories:
- DNS
author: "Matthew Mattox - mmattox@support.tools."
description: "DNS Basics"
more_link: "yes"
---

DNS is a topic that some people just don't get. My goal is to make it as simple as possible for you to understand.

DNS zones fall into three categories:

- Forwarders
- Conditional Forwarders
- Zone Transfers

<!--more-->
# [Forwarders](#forwarders)
DNS queries that are not answered by this server are forwarded to these DNS servers if you are outside my domain/zone. Usually, this is used for external DNS lookups, such as those on the internet.

# [Conditional Forwarders](#conditional-forwarders)
Conditional Forwarders specify that if you aren't in my DNS domain/zone, you will NOT be sent to my Forwarders (above), but to the Forwarders listed here for these specific domains/zones. Using this option, you can select which domains/zones you want requests forwarded to. Active Directory is a common example of this. As an example, you might host `example.com` on your primary DNS servers and conditionally forward `ad.example.com` to your domain controllers.

# [Zone Transfers](#zone-transfers)
Basically, zone transfers allow the whole zone to be transferred to a different DNS server. If you decide to use them, you should lock down the process. I've seen environments with this set to ANY, which poses a security risk. It is easy to imagine how one bad character can sink your entire DNS zone during their RECON stage. However, you may have a case for conditional forwarding if you are trying to accomplish what you are trying to achieve.

# [Setup](#setup)
In the examples below, I'm running PowerDNS as my primary DNS server with a conditional forwarder for `support.local` for Active Directory.

Setup:

PowerDNS Master Server:
- a1ubpdnsmp01 / 172.27.2.19

Note: This server is the primary DNS server for the domain `support.tools` and runs PowerDNS with MariaDB as Read/Write master. It is important to note that no requests are normally sent to this server it's only used for managing PowerDNS.

PowerDNS Slave Servers:

- a1ubpdnsp01 / 172.27.2.23
- a1ubpdnsp02 / 172.27.2.24
- a0ubpdnsp01 / 192.168.69.23

Note: These servers are the slaves for the domain `support.tools` and run PowerDNS with MariaDB as Read-Only slave.

# [Example](#example)

## Local query lookup for `support.local`:

Command
```bash
dig rancher.support.tools
```

Output:
```bash
mmattox@a1ubthorp01:~$ dig rancher.support.tools

; <<>> DiG 9.18.1-1ubuntu1.1-Ubuntu <<>> rancher.support.tools
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 57746
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 512
;; QUESTION SECTION:
;rancher.support.tools.		IN	A

;; ANSWER SECTION:
rancher.support.tools.	33	IN	A	192.243.222.44

;; Query time: 0 msec
;; SERVER: 192.168.69.23#53(192.168.69.23) (UDP)
;; WHEN: Fri Jul 15 11:45:33 CDT 2022
;; MSG SIZE  rcvd: 66

mmattox@a1ubthorp01:~$
```

As you can see the query was answered by the PowerDNS server `192.168.69.23`. Because the zone `support.tools` is hosted on this server, it will be served directly.

## External query lookup for `google.com`:

Command
```bash
dig google.com
```

Output:
```bash
mmattox@a1ubthorp01:~$ dig google.com

; <<>> DiG 9.18.1-1ubuntu1.1-Ubuntu <<>> google.com
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 56419
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 512
;; QUESTION SECTION:
;google.com.			IN	A

;; ANSWER SECTION:
google.com.		112	IN	A	172.217.4.206

;; Query time: 72 msec
;; SERVER: 192.168.69.23#53(192.168.69.23) (UDP)
;; WHEN: Fri Jul 15 11:48:15 CDT 2022
;; MSG SIZE  rcvd: 55

mmattox@a1ubthorp01:~$ 
```

As you can see the query was answered by the PowerDNS server `192.168.69.23` but because the zone `google.com` is not hosted on this server, it was forwarded to CloudFlare `1.1.1.1`.

Note: I'm running PowerDNS Recursor on all my servers so all external DNS queries are forwarded to the PowerDNS Recursor first then to CloudFlare with PowerDNS Recursor acting as a caching layer.

## Forwarded query lookup for `support.local`:

Command:
```bash
dig support.local
```

Output:
```bash
mmattox@a1ubthorp01:~$ dig support.local

; <<>> DiG 9.18.1-1ubuntu1.1-Ubuntu <<>> support.local
;; global options: +cmd
;; Got answer:
;; WARNING: .local is reserved for Multicast DNS
;; You are currently testing what happens when an mDNS query is leaked to DNS
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 18031
;; flags: qr rd ra; QUERY: 1, ANSWER: 3, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 512
;; QUESTION SECTION:
;support.local.			IN	A

;; ANSWER SECTION:
support.local.		593	IN	A	172.27.2.7
support.local.		593	IN	A	192.168.69.26
support.local.		593	IN	A	172.27.2.8

;; Query time: 0 msec
;; SERVER: 192.168.69.23#53(192.168.69.23) (UDP)
;; WHEN: Fri Jul 15 11:52:17 CDT 2022
;; MSG SIZE  rcvd: 90

mmattox@a1ubthorp01:~$ 
```

As you can see the query was answered by the PowerDNS server `192.168.69.23` but because the zone `support.local` has a conditional forwarder, it was forwarded to my Active Directory servers IE `172.27.2.7`, `172.27.2.8`, and `192.168.69.26`. This means my Windows servers and desktop computers will be able to resolve the domain `support.local` even tho their DNS settings point to the PowerDNS servers.

# [Different record types](#different-record-types)
