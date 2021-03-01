+++
Categories = ["Ubuntu"]
Tags = ["Ubuntu", "resolv.conf", "chattr"]
date = "2020-12-09T20:47:00+00:00"
more_link = "yes"
title = "How to disable systemd-resolved in Ubuntu"
+++

In Ubuntu, you may run into an issue when updating /etc/resolv.conf even tho you have root permissions.

Error:

```
rm: cannot remove '/etc/resolv.conf': Operation not permitted
```

<!--more-->
# [Pre-requisites](#pre-requisites)

- Access to a terminal window/command line
- A user account with sudo or root privileges

# [Fix](#fix)

- Verify the file has be marker as immutable:

```
lsattr /etc/resolv.conf
```

Example output:

```
[root@cube ~]# lsattr /etc/resolv.conf
----i--------------- /etc/resolv.conf
```

- Remove the immutable flag

```
sudo chattr -i /etc/resolv.conf
```

- Verify immutable flag has been removed from resolv.conf using the following.

```
lsattr /etc/resolv.conf
```

Example output:

```
[root@cube ~]# lsattr /etc/resolv.conf
-------------------- /etc/resolv.conf
```
