+++
Categories = ["Ubuntu"]
Tags = ["Ubuntu", "resolv.conf"]
date = "2021-03-01T01:14:00+00:00"
more_link = "yes"
title = "How to disable systemd-resolved in Ubuntu"
+++

systemd-resolved can cause issues with Kubernetes (not to mention the time spent troubleshooting various issues).

<!--more-->
# [Fix](#fix)

- Disable the systemd-resolved service

```
sudo systemctl disable systemd-resolved
sudo systemctl stop systemd-resolved
```

- Remove the remove the existing `/etc/resolv.conf` file, which is currently a symbolic link to `/run/systemd/resolve/stub-resolv.conf`

```
sudo rm /etc/resolv.conf
```

- Create a new static `resolv.conf`

```
echo 'search example.com' > /etc/resolv.conf
echo 'nameserver 1.1.1.1' >> /etc/resolv.conf
echo 'nameserver 1.0.0.1' >> /etc/resolv.conf
```

# [References](#references)

- [My War on Systemd-resolved](https://ohthehugemanatee.org/blog/2018/01/25/my-war-on-systemd-resolved/)
- [Disabling systemd-resolvd service on Ubuntu systems](https://www.unixgr.com/disabling-systemd-resolvd-service-on-ubuntu-systems/)
- [AskUbuntu - How do I disable systemd-resolved and replace with something sane on Ubuntu 18?](https://askubuntu.com/questions/1081832/how-do-i-disable-systemd-resolved-and-replace-with-something-sane-on-ubuntu-18/1081835)
- [How to correctly disable systemd-resolved on Ubuntu 18.04](https://blog.mesouug.com/2018/09/22/how-to-correctly-disable-systemd-resolved-on-ubuntu-18-04/)
