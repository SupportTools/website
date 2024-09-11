---
title: "Resolving SchedulingDisabled Nodes in k3s on Raspberry Pi"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["k3s", "Raspberry Pi", "Kubernetes"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to resolve SchedulingDisabled nodes in a k3s cluster on Raspberry Pi, ensuring smooth operation of your applications."
more_link: "yes"
url: "/resolving-schedulingdisabled-nodes-in-k3s-on-raspberry-pi/"
---

Learn how to resolve SchedulingDisabled nodes in a k3s cluster on Raspberry Pi, ensuring smooth operation of your applications.

<!--more-->

# [Resolving SchedulingDisabled Nodes in k3s on Raspberry Pi](#resolving-schedulingdisabled-nodes-in-k3s-on-raspberry-pi)

This morning, I grabbed my Raspberry Pi cluster out of the box and fired it up again. However, my Docker repository wasn’t starting because the container was tied to a specific node that was showing as SchedulingDisabled.

## [Identifying the Issue](#identifying-the-issue)

Using the default k3s local-path storage class ties containers to specific nodes. Let's check the node statuses:

```bash
kubectl get nodes --sort-by '.metadata.name'
```

Example output:

```
NAME     STATUS                     ROLES                  AGE    VERSION
rpi401   Ready                      control-plane,master   154d   v1.21.7+k3s1
rpi402   Ready                      <none>                 154d   v1.21.7+k3s1
rpi403   Ready                      <none>                 152d   v1.21.7+k3s1
rpi404   Ready                      <none>                 152d   v1.21.7+k3s1
rpi405   Ready,SchedulingDisabled   <none>                 152d   v1.21.7+k3s1
```

## [Examining the Node Details](#examining-the-node-details)

To get more details about the SchedulingDisabled node, use:

```bash
kubectl get node rpi405 -o yaml
```

Excerpt of the output:

```yaml
spec:
  taints:
  - effect: NoSchedule
    key: node.kubernetes.io/unschedulable
    timeAdded: "2021-07-10T09:41:33Z"
  unschedulable: true
```

## [Fixing the SchedulingDisabled Node](#fixing-the-schedulingdisabled-node)

Uncordon the node to allow scheduling:

```bash
kubectl uncordon rpi405
```

Output:

```
node/rpi405 uncordoned
```

## [Conclusion](#conclusion)

The puzzling part is that I don’t remember using the `kubectl cordon` command. I vaguely remember messing around with taints, which might have caused the issue. By uncordoning the node, the cluster can now schedule pods on it again, ensuring smooth operation of the applications.

By following these steps, you can resolve SchedulingDisabled nodes in your k3s cluster on Raspberry Pi, ensuring that your applications run smoothly.
