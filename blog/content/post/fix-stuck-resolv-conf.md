+++
Categories = ["Ubuntu"]
Tags = ["Ubuntu", "resolv.conf", "chattr"]
date = "2020-12-09T20:47:00+00:00"
more_link = "yes"
title = "How to Fix 'rm: cannot remove '/etc/resolv.conf': Operation not permitted'"
+++

In Ubuntu, you may run into an issue when updating /etc/resolv.conf even tho you have root permissions.

Error:

<code>
rm: cannot remove '/etc/resolv.conf': Operation not permitted
</code>

<!--more-->
# [Pre-requisites](#pre-requisites)

- Access to a terminal window/command line
- A user account with sudo or root privileges

# [Fix](#fix)

- Verify the file has be marker as immutable:

<code>
lsattr /etc/resolv.conf
</code>

Example output:

<code>
[root@cube ~]# lsattr /etc/resolv.conf
----i--------------- /etc/resolv.conf
</code>

- Remove the immutable flag

<code>
sudo chattr -i /etc/resolv.conf
</code>

- Verify immutable flag has been removed from resolv.conf using the following.

<code>
lsattr /etc/resolv.conf
</code>

Example output:

<code>
[root@cube ~]# lsattr /etc/resolv.conf
-------------------- /etc/resolv.conf
</code>
