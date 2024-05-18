---
title: "Setting Up a VictoriaMetrics Static Scraper on Kubernetes"
date: 2024-05-18T19:26:00-05:00
draft: true
tags: ["k3s", "Kubernetes", "VictoriaMetrics", "Electric Imp"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to set up a VictoriaMetrics static scraper on Kubernetes to monitor metrics from an Electric Imp Environment Tail."
more_link: "yes"
url: "/setting-up-victoriametrics-static-scraper-kubernetes/"
---

Learn how to set up a VictoriaMetrics static scraper on Kubernetes to monitor metrics from an Electric Imp Environment Tail. This guide covers exposing metrics, scraping them with VictoriaMetrics, and visualizing them in Grafana.

<!--more-->

# [Setting Up a VictoriaMetrics Static Scraper on Kubernetes](#setting-up-a-victoriametrics-static-scraper-on-kubernetes)

I’ve got an Electric Imp Environment Tail in my office. It monitors the temperature, humidity, and pressure. Currently, to display a graph, it’s using flot.js and some basic Javascript that I wrote. It remembers samples from the last 48 hours.

Rather than write more Javascript or post it to a third-party metrics service, I’m just going to add it to my cluster’s VictoriaMetrics+Grafana setup.

## [Exposing Metrics](#exposing-metrics)

The first thing to do is to expose the most recent readings in Prometheus-compatible format. I’ve updated the agent source code to include the following:

```javascript
app.get("/metrics", function(context) {
    // Unix epoch, seconds.
    local t = time();
    // Multiplying by 1000 overflows, so just jam some zeroes on the end in the string format.
    context.send(200, format("temperature %f %d000\nhumidity %f %d000\npressure %f %d000\n",
        LATEST.tempHumid.temperature, t,
        LATEST.tempHumid.humidity, t,
        LATEST.pressure.pressure, t));
});
```

## [Scraping Metrics](#scraping-metrics)

To scrape those metrics, we need a `VMStaticScrape` resource:

```yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMStaticScrape
metadata:
  name: imp-environment-tail
  namespace: monitoring-system
spec:
  jobName: "imp-environment-tail-office"
  targetEndpoints:
    - targets: ["agent.electricimp.com"]
      labels:
        env: office
      scheme: "https"
      path: "/agent-id-goes-here/metrics"
```

The annoying part here is that it won’t take a URL; you need to specify the scheme and path separately from the targets. The labels make it easier to find later in Grafana.

## [VMAgent](#vmagent)

To actually run the scraper, we need a `VMAgent` resource:

```yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMAgent
metadata:
  name: agent
  namespace: monitoring-system
spec:
  staticScrapeSelector: {}
  staticScrapeNamespaceSelector: {}
  remoteWrite:
    - url: "<http://vmsingle-vm-database.monitoring-system.svc.cluster.local:8429/api/v1/write>"
```

Note the `<service>.<namespace>.svc.cluster.local` format. The selectors are required as well; otherwise, it doesn’t scrape anything.

## [Agent Status](#agent-status)

You can check the status of the VM agent with the following command and a browser:

```bash
kubectl --namespace monitoring-system port-forward --address 0.0.0.0 service/vmagent-agent 8429:8429
```

## [Grafana](#grafana)

Once that was all working, I quickly cobbled together a dashboard in Grafana to visualize the metrics.

## [Links](#links)

- [Electric Imp](https://electricimp.com)
- [GitHub: imp-environment-tail](https://github.com/rlipscombe/imp-environment-tail)

By following these steps, you can set up a VictoriaMetrics static scraper on Kubernetes to monitor metrics from an Electric Imp Environment Tail and visualize them in Grafana.
