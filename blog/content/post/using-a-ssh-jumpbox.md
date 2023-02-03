+++
Categories = ["Linux"]
Tags = ["Linux", "SSH", "Jumpbox"]
date = "2020-12-11T01:27:00+00:00"
more_link = "yes"
title = "How to access a protected server using a Jumpbox"
+++

It is a common practice to access servers remotely via SSH. Typically, you may have, which is commonly referred to as a "Jumpbox." This server is accessible from the internet or other lesser trusted networks (sometimes this Jumpbox would be in a DMZ or have special firewall rules).

TL;DR
To SSH to a server through a jumpbox, you can use `ssh -J matt@jump.support.tools root@webserver.support.tools`.

<!--more-->
# [Longer Version](#long-version)

When setting up your Linux servers in your data center, your favorite cloud service provider, or under your desk, it is common to add your SSH public key to authorized keys on the server.

That's all fine and well, but typically if you're connecting through the public internet, you wouldn't have access to your protected server(s) because opening SSH access to the public can be a security issue.

This is where the Jumpbox would come into play. You would have access to your jumpbox, and your jumpbox would have access to your secure network. This dramatically reduces the surface attack area for your secure network (and servers).

I usually use the -J option, in the format of ssh -J <Jumpbox> <destination>.

Manpages for SSH(1) explain the following:

-J [user@]host[:port] Connect to the target host by first making an ssh connection to the jump host and establishing a TCP forwarding to the ultimate destination from there. Multiple jump hops may be specified separated by comma characters. This is a shortcut to set a ProxyJump configuration directive.
