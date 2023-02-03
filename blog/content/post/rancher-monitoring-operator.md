---
title: "service rancher-monitoring-operator not found"
date: 2022-09-29T00:51:00-05:00
draft: true
tags: ["Kubernetes", "RKE2", "Rancher", "Monitoring"]
categories:
- kubernetes
- rke2
- rancher
- monitoring
author: "Matthew Mattox - mmattox@support.tools."
description: "Failed to call webhook rancher-monitoring-operator"
more_link: "yes"
---

Error:
```
Error: Internal error occurred: failed calling webhook "prometheusrulemutate.monitoring.coreos.com": failed to call webhook: Post "https://rancher-monitoring-operator.cattle-monitoring-system.svc:443/admission-prometheusrules/mutate?timeout=10s": service "rancher-monitoring-operator" not found
```

This error can be caused by a number of different issues. But first we need to understand what this error means.

The TLDR is that the webhook is not available. The webhook is a service that is used to validate and mutate resources. In this case, the webhook is used to validate and mutate PrometheusRule resources.

<!--more-->
# [Solution](#fix)
This error can be caused by a number of different issues.

## [Rancher Monitoring v2 is broken](#rancher-monitoring-v2-is-broken)

If you are using Rancher Monitoring v2, then you should be using the `rancher-monitoring-crd` chart. This chart is used to install the CRDs for the monitoring stack. If this chart is in a failed state, then the webhook might not be available. To fix this, you can try to upgrade the chart. If that doesn't work, then you can try to uninstall and reinstall the chart.

## [Rancher Monitoring v2 left behind junk](#rancher-monitoring-v2-left-behind-junk)

If you were using Rancher monitoring v2, then uninstall it. This should remove the CRDs and the webhook but it might not. So we need to manually remove the webhook using the following command:

```
kubectl delete validatingwebhookconfiguration.admissionregistration.k8s.io rancher-monitoring-admission
```