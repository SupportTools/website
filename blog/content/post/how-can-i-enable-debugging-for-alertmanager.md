+++
Categories = ["Rancher", "Alertmanager"]
Tags = ["rancher", "alertmanager"]
date = "2020-10-24T07:00:00+00:00"
more_link = "yes"
title = "How to enable debug level logging for the Rancher Cluster/Project Alerting Alertmanager instance, in a Rancher v2.x managed cluster?"
+++

This article details how to enable debug level logging on the Alertmanager instance in a Rancher v2.x managed Kubernetes cluster, which may assist when troubleshooting [cluster](https://rancher.com/docs/rancher/v2.x/en/cluster-admin/tools/alerts/) or [project alerting](https://rancher.com/docs/rancher/v2.x/en/project-admin/tools/alerts/).

<!--more-->
# [Pre-requisites](#pre-requisites)

- A Rancher v2.x managed Kubernetes cluster
- [Cluster](https://rancher.com/docs/rancher/v2.x/en/cluster-admin/tools/alerts/) or [project alerting](https://rancher.com/docs/rancher/v2.x/en/project-admin/tools/alerts/) configured

# [Resolution](#resolution)
- Within the Rancher UI navigate to the System Project of the relevant cluster and click on the Apps view.
- Click 'Upgrade' on the cluster-alerting app.
- In the Answers section click 'Add Answer' and add the variable `alertmanager.logLevel` with a value of `debug`.
- Click upgrade to save the change and update the Alertmanager instance with the debug log level.
- Navigate to the cattle-prometheus namespace within the System Project for the cluster, and view the logs of the	alertmanager-cluster-alerting-0 Pod running for the alertmanager-cluster-alerting StatefulSet. You should see `level=debug` log messages, such as in the following example, confirming debug level logging has been successfully configured:
```
level=debug  ts=2019-07-09T15:03:37.511451301Z caller=dispatch.go:104  component=dispatcher msg="Received alert" alert=[433a194][active]
level=debug  ts=2019-07-09T15:03:38.511774835Z caller=dispatch.go:430  component=dispatcher  aggrGroup="{}/{group_id=\"c-5h85q:event-alert\"}/{rule_id=\"c-5h85q:event-alert_deployment-event-alert\"}:{event_message=\"Scaled  up replica set mynginx2-7994cd84ff to 1\",  resource_kind=\"Deployment\",  rule_id=\"c-5h85q:event-alert_deployment-event-alert\",  target_name=\"mynginx2\", target_namespace=\"default\"}" msg=flushing  alerts=[[433a194][active]]
```
