---
title: "Tailing logs across multiple pods at the same time using Stern"
date: 2023-06-12T19:26:00-05:00
draft: false
tags: ["Kubernetes", "Stern", "Logging"]
categories:
- Kubernetes
- k3s
author: "Matthew Mattox - mmattox@support.tools."
description: "In this post, we explore Stern, a handy tool for tailing logs in a Kubernetes environment."
more_link: "yes"
---

Understanding the status of pods and services in Kubernetes can often be a complex task. The built-in logging capability can help, but there are also additional tools to make this process easier. One is Stern, a log-tailing utility designed explicitly for Kubernetes.

Stern allows you to tail logs from multiple pods in real time, applying color coding to make it easier to distinguish between different pods. Stern supports regular expressions, which can be particularly useful when narrowing your logs down to specific pods or containers.

<!--more-->

# [Introduction to Stern](#introduction-to-stern)
Stern is a log-tailing utility for Kubernetes developed by Wercker. It is a lightweight and versatile tool designed to help monitor and troubleshoot applications running in a Kubernetes environment. This post will explain how to install and use Stern to improve your understanding of what's happening within your Kubernetes cluster.

# [Why Use Stern?](#why-use-stern)
Stern has several features that make it more flexible and powerful than the built-in `kubectl logs` command. These include:

- Tailing multiple pods simultaneously, displaying each log line with a color associated with the pod from which it originates.
- Filtering pods by regular expressions. This means you can focus on the logs from specific pods or containers.
- Auto-reconnecting to pods if they crash or are replaced is particularly useful when tracking issues in a non-stable environment.

# [Getting Started with Stern](#getting-started-with-stern)
Installing Stern on Linux is straightforward. First, download the latest Stern binary from the GitHub releases page:

```
wget https://github.com/stern/stern/releases/download/{version}/stern_{os_arch}.tar.gz
```

Please replace {version} with the version number you wish to install and {os_arch} with your operating system's architecture (such as linux_amd64).

Then extract the tar.gz file and move the binary to /usr/local/bin or any other directory included in your PATH:

```
tar -xvf stern_{os_arch}.tar.gz
sudo mv stern /usr/local/bin
```

You can now verify that Stern is installed correctly:

```
stern --version
```

# [Conclusion](#conclusion)
In conclusion, Stern is a valuable tool for anyone working with Kubernetes who needs a more efficient way to monitor and troubleshoot applications. Its powerful features and flexibility make it a solid complement to the existing Kubernetes logging infrastructure.
