+++
Categories = ["Rancher", "Docker", "RancherOS", "Networking"]
Tags = ["rancher", "docker", "rancheros", "networking"]
date = "2019-11-20T13:18:00+00:00"
more_link = "yes"
title = "Updating the docker bridge for Rancher managed clusters"
+++

The docker0 bridge network has a default IP range of 172.17.0.0/16 (with an additional docker-sys bridge for system-docker using 172.18.0.0/16 by default on RancherOS). These ranges will be routed to these interfaces, per the below example of the route output. If the range(s) overlap with the internal IP space usage in your own network, the host will not be able to route packets to other hosts in your network that lie within these ranges. As a result you may wish to change the bridge range(s) to enable successful routing to hosts within these.

<!--more-->
# [Pre-requisites](#pre-requisites)

This article is only applicable to Kubernetes cluster launched by RKE v0.1.x, v0.2.x and v0.3.x, or Rancher v2.x

# [Fix](#fix)

Updating the `docker0` bridge IP range (and `docker-sys` bridge IP range in RancherOS) is possible in an RKE or Rancher v2.x provisioned Kubernetes cluster, where no cluster containers are in fact running attached to the Docker bridge network. The only impact of the change should be some downtime, as you will be required to restart the Docker daemon for the change to take effect.

On RancherOS the bridge IP range (`bip`) can be updated for docker and system-docker per the RancherOS documentation on (Configuring Docker or System Docker)[https://rancher.com/docs/os/v1.x/en/installation/configuration/docker/]. You will need to reboot the host for the change to take effect after updating the settings.

For other operating systems, where Docker is installed from the upstream Docker repositories, you should update the `bip` configuration in `/etc/docker/daemon.json` per the (dockerd documentation)[https://docs.docker.com/engine/reference/commandline/dockerd/#daemon-configuration-file].

On CentOS 7, RHEL 7 and SLES 12 you should also check the configuration in /etc/sysconfig/docker to ensure `--bip` has not been configured there.
