+++
Categories = ["Rancher", "Ingress-Nginx"]
Tags = ["rancher", "nginx"]
date = "2021-02-28T16:49:00+00:00"
more_link = "yes"
title = "How to block specific user agents from connecting through the nginx ingress controller"
+++

At times it's necessary to block specific user agents from connecting to workloads within your cluster. Whether it's bad actors or for compliance reasons, we'll go through how to get it done with Rancher/RKE created clusters.

<!--more-->
# [Pre-requisites](#pre-requisites)

- A Rancher Kubernetes Engine (RKE) or Rancher v2.x provisioned Kubernetes cluster with Nginx for its ingress controller.

# [Resolution](#resolution)

## Identify the user agents that will be blocked.

There are multiple ways to surface user agents needing to be blocked, the most practical being your nginx ingress controllers' logs. In the logs one would see something similar to the following entries:

```
172.16.10.101 - - [02/Jan/2021:21:51:22 +0000] "GET / HTTP/1.1" 200 45 "-" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.16; rv:84.0) Gecko/20100101 Firefox/84.0" 367 0.001 [default-ingress-1db0bf370dd59aa8ff284a4bd4ccdc07-80] [] 10.42.0.10:80 45 0.000 200 1da439122bd7d7014f6627f32e4cefc3
172.16.10.101 - - [02/Jan/2021:21:51:22 +0000] "GET /favicon.ico HTTP/1.1" 499 0 "http://test.default.54.202.152.214.xip.io/" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.16; rv:84.0) Gecko/20100101 Firefox/84.0" 341 0.001 [default-ingress-1db0bf370dd59aa8ff284a4bd4ccdc07-80] [] 10.42.0.10:80 0 0.000 - 92a1e851206da86fbec0610d346e2ddd
172.16.10.101 - - [02/Jan/2021:21:51:26 +0000] "GET / HTTP/1.1" 200 45 "-" "curl/7.64.1" 98 0.000 [default-ingress-1db0bf370dd59aa8ff284a4bd4ccdc07-80] [] 10.42.0.10:80 45 0.000 200 4c51046660b05cf2703dbedfae2272aa
172.16.10.101 - - [02/Jan/2021:21:51:29 +0000] "GET / HTTP/1.1" 200 45 "-" "Wget/1.20.3 (darwin19.0.0)" 164 0.001 [default-ingress-1db0bf370dd59aa8ff284a4bd4ccdc07-80] [] 10.42.0.10:80 45 0.000 200 5334e799b3268dab31d74a5d2239702b
```

We can see three unique user agents here; `curl`, `Wget`, and `Mozilla/5.0`.

## Modify the cluster.yaml to include the Nginx option to block user agents

In the example configuration, we'll block connections from curl and Mozilla using regular expressions. It's essential to separate the list of agents we're looking to restrict with commas.

```
  ingress:
    options:
      block-user-agents: '~*curl.*,~*Mozilla.*'
    provider: nginx
```

## Test the configuration

Navigating to the workload or service behind the ingress now blocks the agents blacklisted.

```
172.16.10.101 - - [02/Jan/2021:22:23:00 +0000] "GET / HTTP/1.1" 200 45 "-" "Wget/1.20.3 (darwin19.0.0)" 164 0.000 [default-ingress-1db0bf370dd59aa8ff284a4bd4ccdc07-80] [] 10.42.0.10:80 45 0.004 200 df2b5c3fca1ba33683e8ee6d2708b214
172.16.10.101 - - [02/Jan/2021:22:23:05 +0000] "GET / HTTP/1.1" 403 153 "-" "curl/7.64.1" 98 0.000 [] [] - - - - 1902bca1f3622bf5374f966358b10463
172.16.10.101 - - [02/Jan/2021:22:31:56 +0000] "GET / HTTP/1.1" 403 153 "-" "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.16; rv:84.0) Gecko/20100101 Firefox/84.0" 478 0.001 [default-ingress-1db0bf370dd59aa8ff284a4bd4ccdc07-80] [] 10.42.0.10:80 0 0.004 304 9e0df037eaea1afedc5d3c93229dca80
```
