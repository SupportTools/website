+++
Categories = ["VMware", "ESXi"]
Tags = ["vmware", "esxi"]
date = "2021-10-24T01:50:00+00:00"
more_link = "yes"
title = "ESXi boot stuck at iscsi_vmk load successfully"
+++

Problem: ESXi boot slow/stalled/stuck at “iscsi_vmk loaded successfully”

![](https://cdn.support.tools/posts/esxi-boot-stuck-at-iscsivmk/esxi07_stuck_at_iscsi.jpg)

<!--more-->
# [Cause](#cause)

Unfortunately, this is normal due to:
- Dynamic Discovery
- Software, iSCSI Adapter LoginTimeout=XX, causes XX second timeout for each Dynamic discovery.

# [Fix](#fix)
- Leave it alone !! (It's just slow.)
- Reduce LoginTimeout (Dell recommends LoginTimeout=60, but that's a "wait." Try 20.)
- Make it all static. (Meh, too much work.)

Additional troublshooting: Alt+F12 for console logs.