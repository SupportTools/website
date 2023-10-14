---
title: "How to Fix 'Migrate greyed out in vCenter for a single VM'"
date: "2020-12-22T10:56:00+00:00"
draft: false
tags: ["VMWare", "esxi", "vm", "vcenter"]
categories:
- VMWare
more_link: "yes"
---

While migrating some VMs to a new storage array, I ran into an issue while moving the last VM, which, of course, was my vCenter appliance. When I right-clicked the VM in vCenter, then went to migrate. The migration option was greyed out, which blocked the migration.

TL;DR
Follow VMware's KB [1029926](https://kb.vmware.com/s/article/1029926)

<!--more-->
## [Longer Version](#longer-version)

Note: All examples will use the URL https://vcenter. It would be best if you changed this to be your vCenter URL.

- Select the VM in question
- Copy the URL in the browser

Example:

```bash
https://vcenter/ui/#?extensionId=vsphere.core.vm.summary&objectId=urn:vmomi:VirtualMachine:vm-15:......
```

- Grab the VM ID from the URL. In the example the ID is "15"
- Open a new browser windows to https://vcenter/mob/?moid=AuthorizationManager&method=enableMethods
- Login with an Admin user. Example: administrator@vsphere.local
- Enter the following in the value fields replacing the VM ID.
- Entity

```code
<!-- array start -->
<entity type="ManagedEntity" xsi:type="ManagedObjectReference">vm-15</entity>
<!-- array end -->
```

- Method

```code
<method>RelocateVM_Task</method>
```

- Click Invoke Method
- Go back to your vCenter URL and refresh the page.
- You should be able to migrate the VM now.
