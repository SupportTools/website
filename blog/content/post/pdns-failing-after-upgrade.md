+++
Categories = ["PowerDNS", "MySQL"]
Tags = ["PowerDNS", "pdns", "MySQL"]
date = "2020-12-09T20:32:00+00:00"
more_link = "yes"
title = "How to Fix 'Backend error: GSQLBackend unable to list keys' in PowerDNS"
+++

After upgrading to Ubuntu 20.10, you may sometimes encounter an error when attempting to start PowerDNS:

```
Backend error: GSQLBackend unable to list keys: Could not prepare statement: select cryptokeys.id, flags, active, published, content from domains, cryptokeys where cryptokeys.domain_id=domains.id and name=?: Unknown column 'published' in 'field list'
```

<!--more-->
# [Pre-requisites](#pre-requisites)

- Access to a terminal window/command line
- A user account with sudo or root privileges
- MySQL Access to the backend database that supports PowerDNS

# [Fix](#fix)

- Before making any changes, we want to back up the current database.

```
mysqldump -u root -p -B pdns > pdns_backup.sql
```

- We now want to add the missing column to the table cryptokeys

```
mysql -u root -p
use pdns;
ALTER table cryptokeys add column published BOOL DEFAULT 1 after active;
```

- Now we want to restart pdns

```
systemctl restart pdns
```
