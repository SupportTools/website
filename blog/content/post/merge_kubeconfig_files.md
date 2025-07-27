---
title: "How to merge Kubernetes kubectl config files"
date: 2022-07-14T15:00:00-05:00
draft: false
tags: ["Kubernetes", "kubeconfig"]
categories:
- Kubernetes
- kubeconfig
author: "Matthew Mattox - mmattox@support.tools"
description: "How to merge Kubernetes kubectl config files"
more_link: "yes"
---

Sometimes when working with a new Kubernetes cluster you will be given a config file to use when authenticating with the cluster. This file should be placed at ~/.kube/config. However you may already have an existing config file at that location and you need to merge them together.

<!--more-->
# [Steps](#steps)

## Here is a quick command you can run to merge your two config files.

Note: For the example below I'm going to assume the new config file is called `~/.kube/new_config` and the existing config file is called `~/.kube/config`.

### Make a copy of your existing config 
```bash
cp ~/.kube/config ~/.kube/config_bk
```

### Merge the two config files together into a new config file 
```bash
KUBECONFIG=~/.kube/config:~/.kube/new_config kubectl config view --flatten > ~/.kube/config_tmp
```

### Replace your old config with the new merged config 
```bash
mv /tmp/config ~/.kube/config 
```

### (optional) Delete the backup once you confirm everything worked ok
```bash
rm ~/.kube/config_bk
```

## Here is all of that (except the cleanup) as a one-liner.
```bash
cp ~/.kube/config ~/.kube/config_bk && KUBECONFIG=~/.kube/config:~/.kube/new_config kubectl config view --flatten > ~/.kube/config_tmp && mv /tmp/config ~/.kube/config
```