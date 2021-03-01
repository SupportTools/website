+++
Categories = ["Rancher"]
Tags = ["rancher"]
date = "2021-02-28T16:26:00+00:00"
more_link = "yes"
title = "How to enable Envoy access logging in Rancher v2.3+ deployed Istio"
+++

This article details how to enable [Envoy's access logging](https://istio.io/v1.5/docs/tasks/observability/logs/access-log/), for [Rancher deployed Istio](https://rancher.com/docs/rancher/v2.x/en/istio/v2.3.x-v2.4.x/), in Rancher v2.3+

<!--more-->
# [Pre-requisites](#pre-requisites)

To enable Access loggings for Envoy, Rancher deployed Istio by setting the `global.proxy.accessLogFile` path and `global.proxy.accessLogEncoding` type via Custom Answers on the Istio configuration.

Setting the `accessLogFile` path to `/dev/stdout` will route the Envoy access logs to the `istio-sidecar` container logs, exposing them via `kubectl logs` or any log forwarding endpoint you have configured in the cluster.

The log format, specified in `accessLogEncoding,` can be set to JSON or TEXT.

To enable access logging, perform the following steps:

- Navigate to the cluster view in the Rancher UI for the desired cluster and select `Tools` > `Istio.`
- Under the `Custom Answers` section, enter the following two value pairs and click `Save` or `Enable` (the option will depend on whether you have Istio enabled in the cluster already):

    ```
    global.proxy.accessLogFile=/dev/stdout
    global.proxxy.accessLogEncoding=JSON
    ```

- After enabling access logging, you can test the configuration with the Istio `sleep` and `httpbin` sample applications, per [the Istio documentation](https://istio.io/v1.5/docs/tasks/observability/logs/access-log/).

# [Further reading](#further-reading)
- [Istio "Getting Envoy's Access Logs" Documentation](https://istio.io/v1.5/docs/tasks/observability/logs/access-log/)
- [Envoy Access Logging Documentation](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/observability/access_logging.html)
