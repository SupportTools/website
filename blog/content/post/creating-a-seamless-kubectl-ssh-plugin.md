---
title: "Creating a Seamless kubectl ssh Plugin for Easy Pod Access"
date: 2024-05-18
draft: false
tags: ["Kubernetes"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to create a kubectl ssh plugin for effortless pod access in Kubernetes."
more_link: "yes"
url: "/creating-a-seamless-kubectl-ssh-plugin/"
---

In [this post]({% post_url 2022/2022-12-22-erlang-cluster-k8s-ssh %}), we explored a method to access the Erlang console via SSH using `kubectl port-forward`. While functional, the process involves multiple steps and commands, making it less than ideal for quick access. Wouldn't it be convenient to have a one-step solution by running a simple command like `kubectl ssh POD`? Let's dive into creating a kubectl plugin for seamless pod access.

## Simplifying with kubectl Plugins

Implementing a kubectl plugin is quite straightforward. By placing the plugin script in your `$PATH`, you can invoke it as a regular `kubectl` command. Consider the simple `kubectl-hello` plugin script below:

```bash
#!/usr/bin/env bash
echo "Hello kubectl!"
```

Running `kubectl hello` after marking the script as executable will output `Hello kubectl!` with ease.

## Crafting the kubectl ssh Plugin

To streamline pod access, we can create a `kubectl-ssh` script that automates the port forwarding and SSH connection process. By using redirection and proper scripting, the plugin can efficiently handle the necessary steps. Below is a snippet demonstrating the `kubectl-ssh` script:

```bash
#!/usr/bin/env bash

exec 3< <(kubectl port-forward "$@" 0:22)

# When the script exits, kill the port-forward process
pid=$!
trap "kill $pid" EXIT

# Extract the local port number
read <&3 -r line

re='^Forwarding from .*:([0-9]+) -> 22$'
if [[ $line =~ $re ]]; then
    port="${BASH_REMATCH[1]}"

    # Connect to the local port using SSH; disable host key validation
    ssh -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost
else
    exit 1
fi
```

By making this script executable and placing it in your `$PATH`, you'll have a simplified way to SSH into pods.

## Enhancing with Tab Completion

Since version 1.26.0, kubectl supports tab completion for plugins, optimizing the user experience. To enable this feature, create a `kubectl_complete-ssh` script as shown below:

```bash
#!/bin/sh

exec kubectl __complete port-forward "$@"
```

With this script in place and appropriately configured, you can leverage tab completion seamlessly.

By creating a kubectl ssh plugin, you can significantly improve your workflow efficiency when interacting with pods in Kubernetes. This streamlined approach simplifies the process, making pod access hassle-free and more intuitive for users.

For the full source code of the `kubectl-ssh` script and further details, you can visit the [repository here](https://github.com/rlipscombe/kubectl-ssh).

Remember to stay informed about any platform-specific considerations, as highlighted in the blog post.

---

# [Previous Post](#temp)
Let's create a seamless kubectl ssh plugin for easy pod access!
