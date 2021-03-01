+++
Categories = ["Rancher"]
Tags = ["rancher"]
date = "2021-02-28T22:53:00+00:00"
more_link = "yes"
title = "How to increase the log level of Kubernetes components in an RKE CLI or Rancher provisioned Kubernetes cluster"
+++

When troubleshooting an issue with an RKE CLI or Rancher provisioned Kubernetes cluster, it may help to increase the verbosity of logging on one or more of the Kubernetes components above the default level. This article details the process of increasing logging on both those components that use the Kubernetes hyperkube image (kubelet, kube-apiserver, kube-controller-manager, kube-scheduler, kube-proxy) as well as the etcd component.

<!--more-->
# [Pre-requisites](#pre-requisites)

- Rancher v2.x or newer
- RKE v0.2.x or newer

# [Resolution](#resolution)

### Kubernetes API Server, Controller Manager, Scheduler, Kube Proxy, and Kubelet

The Kubernetes core components, which run using the Kubernetes hyperkube image, will log ERROR, WARNING, and INFO messages. The INFO level log output's verbosity is controlled by the `--v` flag, which is set to an integer from 0 to 9. In an RKE CLI or Rancher launched Kubernetes cluster, the `--v` flag is configured to `2` by default. At this level, the components will log `useful steady-state information about the service and important log messages that may correlate to significant changes in the system.`

When troubleshooting an issue, it may be useful to increase the verbosity flag to one of the following:

| Verbosity | Description |
| --------- | ----------- |
| --v=3 | Extended information about changes. |
| --v=4 | Debug level verbosity. |
| --v=6 | Display requested resources. |
| --v=7 | Display HTTP request headers. |
| --v=8 | Display HTTP request contents. |
| --v=9 | Display HTTP request contents without truncation of contents. |

### Update the `--v` flag in an RKE CLI launched cluster

- First, set the `--v` flag for the desired components within the `cluster.yml.` For each of the services you wish to change the verbosity on, you should add an extra_args option with `v: "<value>"` in the services block, per the example below. The appropriate name for each service within this block can be found [within the RKE documentation](https://rancher.com/docs/rke/latest/en/config-options/services/). **N.B. Please see the separate section below for updating the log verbosity of the etcd component**
```
  services:
    kube-api:
      extra_args:
        v: '9'
```
- Having set the flag in the cluster.yml, run `rke up --config cluster.yml` to update the cluster with the new configuration.

### Update the `--v` flag in a Rancher launched cluster

Navigate to the cluster within the Rancher UI and click `Edit Cluster,` then `Edit as YAML.` For each of the services you wish to change the verbosity on, you should add an extra_args option with `v: "<value>"` in the cluster's services block, per the example below.

**N.B. Please see the separate section below for updating the log verbosity of the etcd component.**
```
services:
  kube-api:
    extra_args:
      v: '9'
```

The appropriate name for each service within this block can be found [within the RKE documentation](https://rancher.com/docs/rke/latest/en/config-options/services/).

Having set the verbosity flag, click `Save` at the bottom of the page to update the cluster.

### etcd

The etcd component is configured to log at an INFO level by default in an RKE CLI or Rancher launched Kubernetes cluster, but this can be set to DEBUG level by setting the `--debug=true` flag.

### Update etcd verbosity in an RKE CLI launched cluster

- First set the `--debug=true` flag, within the `cluster.yml` cluster configuration file, under `extra_args` for the etcd service, per the following example:
```
  services:
    etcd:
      extra_args:
        debug: 'true'
```

- Having set the flag in the cluster.yml, run `rke up --config cluster.yml` to update the cluster with the new configuration.

### Update etcd verbosity in a Rancher launched cluster

Navigate to the cluster within the Rancher UI and click `Edit Cluster,` then `Edit as YAML.` Set the `--debug=true` flag under `extra_args,` for the etcd service, per the following example:
```
services:
  etcd:
    extra_args:
      debug: 'true'
```

Having set the debug flag, click `Save` at the bottom of the page to update the cluster.
