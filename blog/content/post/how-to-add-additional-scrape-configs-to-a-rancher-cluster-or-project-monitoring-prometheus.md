+++
Categories = ["Rancher", "Prometheus"]
Tags = ["rancher", "prometheus"]
date = "2021-02-28T23:11:00+00:00"
more_link = "yes"
title = "How to add additional scrape configs to a Rancher cluster or project monitoring Prometheus"
+++

[The Rancher cluster and project monitoring tools](https://rancher.com/docs/rancher/v2.x/en/cluster-admin/tools/monitoring/#monitoring-scope), allow you to monitor cluster components and nodes, as well as workloads and [custom metrics from any HTTP or TCP/UDP metrics endpoint](https://rancher.com/docs/rancher/v2.x/en/project-admin/tools/monitoring/#project-metrics) that these workloads expose.

This article will detail how to manually define additional scrape configs for either the cluster or project monitoring Prometheus instance, where you want to scrape other metrics.

Whether to define the additional scrape config at the cluster or project level would depend on the desired scope for the metrics and possible alerts. If you wish to scope the metrics scraped and likely alerts configured for these metrics, you could configure the additional scrape config at the project monitoring level to a project. If you wish to scope the metrics at the cluster level, only those with cluster-admin access could see the metrics or configure alerts. You could configure the additional scrape config at the cluster monitoring level.


<!--more-->
# [Pre-requisites](#pre-requisites)

- A Rancher v2.2.x, v2.3.x or v2.4.x managed cluster, with [cluster monitoring](https://rancher.com/docs/rancher/v2.x/en/cluster-admin/tools/monitoring/#enabling-cluster-monitoring) enabled (and optionally project monitoring enabled if you wish to configure the additional scrape config at the project scope).

# [Resolution](#resolution)
For both cluster and project monitoring, the additional scrape config(s) are defined in the Answers section of the Monitoring configuration. This can be found as follows:

- Cluster Monitoring: As a user with permissions to edit cluster monitoring (global admins and cluster owners by default), navigate to the cluster view and click Tools -> Monitoring from the menu bar. Click 'Show advanced options' at the bottom right.
- Project Monitoring: As a user with permissions to edit project monitoring (global admins, cluster owners, and project owners by default), navigate to the project and click Tools -> Monitoring from the menu bar. Click 'Show advanced options' at the bottom right.

You can add an array of Prometheus.additionalScrapeConfigs in the Answers section here.

For example to define a scrape job of the following:

```
 - job_name: "prometheus"
   static_configs:
   - targets:
     - "localhost:9090"
```

You would add the following two definitions to the Answers section:

prometheus.additionalScrapeConfigs[0].job_name = prometheus
prometheus.additionalScrapeConfigs[0].static_configs[0].targets[0] = localhost:9090

After adding the answers, click 'Save,' and you should now be able to view the target and its status within the Prometheus UI under Status -> Targets.

# [Further reading](#further-reading)

Documentation on the Rancher cluster monitoring [can be found here](https://rancher.com/docs/rancher/v2.x/en/cluster-admin/tools/monitoring/) and for Rancher project monitoring [here](https://rancher.com/docs/rancher/v2.x/en/project-admin/tools/monitoring/).
