+++
Categories = ["Rancher", "Rancher v1.6"]
Tags = ["rancher", "rancher v1.6"]
date = "2021-02-28T23:26:00+00:00"
more_link = "yes"
title = "How to resolve a service stuck in Removing in Rancher v1.6"
+++

In Rancher v1.6, sometimes a service can be stuck in a `removing` state.

![](/images/how-to-resolve-a-service-stuck-in-removing/service-stuck-removing_small.jpg)

All containers of this service were already deleted in the user interface. I verified this on the Docker hosts using "docker ps -a," and yes, all container instances were correctly removed. But the service in Rancher was still stuck in removing.

Furthermore, in Admin -> Processes the service.remove processes (which seem to because of being stuck in that service removing in progress) never disappeared and were re-started every 2 minutes:

![](/images/how-to-resolve-a-service-stuck-in-removing/rancher-service-remove-running_small.jpg)
![](/images/how-to-resolve-a-service-stuck-in-removing/rancher-service-remove-restarted_small.jpg)

Although I'm not sure what caused this, the reason *might* be several actions happening on that particular service almost at the same time:

![](/images/how-to-resolve-a-service-stuck-in-removing/rancher-audit-logs_small.jpg)

<!--more-->
# [Resolution](#resolution)
As you can see, while I attempted a service rollback, another user deleted the same service at (almost) the same time. I wouldn't be surprised if this has upset Rancher in such a way that the "delete" task happened faster than the "rollback," causing the "rollback" to hiccup the system. The second "delete" attempt was to see if it would somehow "force" the removal, but it didn't work. So far to the theory (only someone from Rancher could eventually confirm this or better give the real reason for what has happened), let's solve this.

Because all attempts using the Rancher UI and API failed (the service stayed in removing state), I began my research and came across the following issues:

- [https://forums.rancher.com/t/solved-how-to-remove-delayed-processes-which-have-been-stuck-for-months/6034](https://forums.rancher.com/t/solved-how-to-remove-delayed-processes-which-have-been-stuck-for-months/6034)
- [https://github.com/rancher/rancher/issues/8316](https://github.com/rancher/rancher/issues/8316)
- [https://forums.rancher.com/t/forcefully-remove-service/5892/3](https://forums.rancher.com/t/forcefully-remove-service/5892/3)
- [https://github.com/rancher/rancher/issues/16694](https://github.com/rancher/rancher/issues/16694)

# [MySQL](#mysql)

- To resolve this issue, we'll need to login into the MySQL database that supports Rancher v1.6.

```
##Find the open process
select * from process_instance WHERE end_time is NULL;

##Kill all open process - if there is quite a large amount
UPDATE process_instance SET exit_reason='DONE', end_time=NOW() WHERE end_time is NULL;
```

- If the service is still stuck in the removing status, then we'll try to force the service back into Active status.

- We'll want to grab the `resource_id` using the following SQL.

```
select * from process_instance where end_time is NULL and process_name = 'service.remove';
```

- We'll first try to force the service back into Active then delete it again.

```
UPDATE service SET state = 'active' WHERE id = <<resource_id>>;
```

- If the service fails to go back into Active status, we'll want to force remove it.
```
UPDATE service SET state = 'removed', removed = NOW(), remove_time = NOW() WHERE id = <<resource_id>>;
```
