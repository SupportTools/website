+++
Categories = ["kubernetes"]
Tags = ["kubernetes"]
date = "2021-09-13T21:14:00+00:00"
more_link = "yes"
title = "Forcefully Delete Kubernetes Pod"
+++

A pod has been deleted and remains in a status of Terminated for more than a few seconds.
This can happen because:
- The pod has a finalizer associated with it that is not completing, or
- The pod is not responding to termination signals

If pods have been deleted and remain in a Terminated state for a long time, or a time longer than is expected.
When running a kubectl get pods command, you will see a line like this in the output for your pod:
```
NAME                     READY     STATUS             RESTARTS   AGE
swiss-army-knife-qasd2   1/1       Terminating        0          1h
```

<!--more-->
# [Pre-requisites](#pre-requisites)

- kubectl access to the cluster with delete/edit permissions

# [Investigation](#investigation)

- Gather information
```
kubectl get pod -n <Namespace> -p <PodName> -o yaml
```

- Check for finalizers
First, we check to see whether the pod has any finalizers. If it does, their failure to complete may be the root cause.

- We need to review the yaml output and look for a `finalizers` section under `metadata.` See example output below.
```
...
  resourceVersion: "111013082"
  uid: 45562c9f-0a33-424c-92fd-04d794657fcb
spec:
  finalizers:
  - kubernetes
status:
  conditions:
  - lastTransitionTime: "2021-09-14T01:39:04Z"
    message: All resources successfully discovered
    reason: ResourcesDiscovered
    status: "False"
...
```

If any finalizers are present, then go to Solution A

- Check the status of the node

The node your pod(s) is/are running on may have failed in some way.

If you see from the yaml output that all pods on the same node are Terminating on a specific node, this may be the issue.

- Delete the pod

The pod may not be terminating due to a process that is not responding to a signal. The exact reason will be context-specific and application-dependent. Common causes include:

  - A tight loop in userspace code that does not allow for interrupt signals
  - A maintenance process (e.g., garbage collection) on the application runtime

In these cases, Solution B may resolve the issue.

- Restart kubelet
If nothing else works, it may be worth restarting the kubelet on the node the pod was trying to run on. See the output of

See solution C

# [Resolution](#resolution)

- Solution A - Remove finalizers
To remove any finalizers from the pod, run:

```
kubectl -n <Namespace> patch pod <PodName> -p '{"metadata":{"finalizers":null}}'
```

- Solution B - Force delete the pod
Please note that this is more of a workaround than a solution and should be done to ensure that it won’t result in further problems. See also [here](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/) for information pertaining to StatefulSets.

To force-delete the pod, run:
```
kubectl -n <Namespace>  delete pod --grace-period=0 --force <PodName>
```

If this does not work, then return to the previous step.

- Solution C - Restart kubelet
Suppose you can SSH to the node and restart the kubelet process. If you do not have access or permission, this may require an administrator to get involved.

Before you do this (and if you have access), check the kubelet logs to see any issues in the kubelet logs.

- Check Resolution
If the specific pod no longer shows up when running kubectl get pods

Command:
```
kubectl -n <Namespace> get pod -p <PodName> -o yaml
```

Output:
```
NAME                     READY     STATUS             RESTARTS   AGE
````

If the output is empty, then the issue has been resolved.


# [Further Steps](#further-steps)

If the issue recurs (or not), you may want to:
  - Check whether the finalizer’s work needs to be still done
  - Determine the root cause

- Check whether the finalizer’s work needs to be still done

This will vary depending on what the finalizer did.

See further information for guidance on finalizers.

Common causes of finalizers not completing include:
  - Volume

- Determine the root cause
This will vary depending on what the finalizer did and will require context-specific knowledge.

Some tips:
  - If you have access, check the kubelet logs. Controllers can log helpful information there.


# [Further Information](#further-info)

[Finalizers](https://kubernetes.io/docs/tasks/access-kubernetes-api/custom-resources/custom-resource-definitions/#finalizers)
[Container Lifecycle Hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
[Termination of Pods](https://kubernetes.io/docs/concepts/workloads/pods/pod/#termination-of-pods)
[Unofficial Kubernetes Pod Termination](https://unofficial-kubernetes.readthedocs.io/en/latest/concepts/abstractions/pod-termination/)
[Kubelet logs](https://kubernetes.io/docs/tasks/debug-application-cluster/debug-cluster/#looking-at-logs)