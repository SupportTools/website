+++
Categories = ["VMware", "vCenter", "AD"]
Tags = ["vmware", "vcenter", "ad"]
date = "2022-02-15T22:21:00+00:00"
more_link = "yes"
title = "Removing vCenter from died Active Directory"
+++

I lost both of my domain controllers earlier this week, even after I restored one from a VM backup. There was too much corruption. As a result, I rebuilt my domain with new domain controllers, joined all my Windows virtual machines to the new domain, recreated my user accounts, etc. One of the challenges I ran into was getting my vCenter to leave the old domain so it could join the new domain. The old domain was no longer available, so I could not leave it.

When trying to “Leave Active Directory Domain” in the GUI, I got the following error:

```
ldm client exception: Error trying to leave AD, error code [1332], user [mmattox@ad.support.tools]
```

<!--more-->
# [Leaving Domain via CLI](#leaving-domain-via-cli)

We are going to assume you have ssh and shell access to your vCenter applicance.

- Run the command `/opt/likewise/bin/domainjoin-cli query`

You should get an output like this:
```
root@a1apvcenterp01 [ ~ ]# /opt/likewise/bin/domainjoin-cli query

Error: LW_ERROR_DOMAIN_IS_OFFLINE [code 0x00009cb9]

The domain is offline
root@a1apvcenterp01 [ ~ ]#
```

- Now try running the command `/opt/likewise/bin/domainjoin-cli leave` to leave the domain.

You should get an output like this:
```
root@a1apvcenterp01 [ ~ ]# /opt/likewise/bin/domainjoin-cli leave
Leaving AD Domain:   AD.SUPPORT.TOOLS

Error: ERROR_MEMBER_NOT_IN_GROUP [code 0x00000529]


root@a1apvcenterp01 [ ~ ]#
```

- Now, reboot the vCenter and the domain was gone.
