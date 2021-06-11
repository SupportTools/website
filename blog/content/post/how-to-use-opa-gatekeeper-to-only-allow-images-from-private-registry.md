+++
Categories = ["kubernetes", "opa gatekeeper"]
Tags = ["kubernetes", "opa", "gatekeeper", "opa gatekeeper"]
date = "2021-06-11T01:11:00+00:00"
more_link = "yes"
title = "How to use OPA Gatekeeper to only allow images from a private registry."
+++

By default, Kubernetes will pull from Docker Hub unless the deployment requests a fully qualified path. For example, if you deploy a pod with the image `rancherlabs/swiss-army-knife,` Kubernetes will default index.docker.io/rancherlabs/swiss-army-knife.` This is works for environments that can pull images from the internet. But in environments that don't have internet access or if your security team requires all images to be scanned before being deployed. To solve this issue, you'll need to instruct your application teams to update to use a private registry IE `private.example.com/rancherlabs/swiss-army-knife.`, But there is always a chance that an application team forgets to change their image path in their code. Now you have pods stuck in `imagepullbackoff.` To prevent this kind of issue, we will set up OPA Gatekeeper to block all deployment requests that are missing our private registry IE `private.example.com.`

<!--more-->
# [Pre-requisites](#pre-requisites)

- kubectl access to cluster with admin permissions
- A private docker registry

# [Installation](#install)

- For Rancher environments, please see [Doc](https://rancher.com/docs/rancher/v2.5/en/opa-gatekeper/) for installation steps.
- For Non-Rancher environments, please see [Doc](https://open-policy-agent.github.io/gatekeeper/website/docs/install/)

# [Creating policy](#policy)

- Create a file named `constraint_template.yaml` with the following content:
```
apiVersion: templates.gatekeeper.sh/v1beta1
kind: ConstraintTemplate
metadata:
  name: k8sallowedrepos
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedRepos
      validation:
        # Schema for the `parameters` field
        openAPIV3Schema:
          properties:
            repos:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedrepos

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          satisfied := [good | repo = input.parameters.repos[_] ; good = contains(container.image, repo)]
          not any(satisfied)
          msg := sprintf("container <%v> has an invalid image repo <%v>, allowed repos are %v", [container.name, container.image, input.parameters.repos])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.initContainers[_]
          satisfied := [good | repo = input.parameters.repos[_] ; good = contains(container.image, repo)]
          not any(satisfied)
          msg := sprintf("container <%v> has an invalid image repo <%v>, allowed repos are %v", [container.name, container.image, input.parameters.repos])
        }
```

- Then apply the ConstraintTemplate to the cluster by running:
```
kubectl apply -f constraint_template.yaml
```

- Create a file named `constraint.yaml` with the following content:
```
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: allow-only-private-registry
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
  parameters:
    repos:
      - "private.example.com"
```

NOTE: We'll want to change `private.example.com` to match the name of your private registry. Also, you can have more than one registry in the list.

- Then, apply the Constraint to the cluster by running:
```
kubectl apply -f constraint.yaml
```

# [Test the policy](#test)

To test that our new policy is working correctly, we're going to try deploying two files. `allowed.yaml` should work with `disallowed.yaml` being blocked.

- Create a file named `allowed.yaml` with the following content:
```
apiVersion: v1
kind: Pod
metadata:
  name: swiss-army-knife-allowed
spec:
  containers:
    - name: swiss-army-knife
      image: private.example.com/rancherlabs/swiss-army-knife:latest
      resources:
        limits:
          cpu: "100m"
          memory: "30Mi"
```

NOTE: We'll want to change `private.example.com` to match the name of your private registry.

- Create a file named `disallowed.yaml` with the following content:
```
apiVersion: v1
kind: Pod
metadata:
  name: swiss-army-knife-disallowed
spec:
  containers:
    - name: swiss-army-knife
      image: rancherlabs/swiss-army-knife:latest
      resources:
        limits:
          cpu: "100m"
          memory: "30Mi"
```

- Then, create the allowed pod to the cluster by running:
```
kubectl apply -f allowed.yaml
```

- We should see the following output:
```
pod/swiss-army-knife-allowed created
```

- Then, create the disallowed pod to the cluster by running:
```
kubectl apply -f disallowed.yaml
```

- We should see the following output:
```
Error from server ([denied by allow-only-private-registry] container <swiss-army-knife> has an invalid image repo <swiss-army-knife>, allowed repos are ["private.example.com"]): error when creating "disallowed.yaml": admission webhook "validation.gatekeeper.sh" denied the request: [denied by allow-only-private-registry] container <swiss-army-knife> has an invalid image repo <swiss-army-knife>, allowed repos are ["private.example.com"]
```

- You should also see that the blocked pod was not created, but the allowed pod was.
```
NAME                      READY   STATUS             RESTARTS   AGE
swiss-army-knife-allowed  1/1     Running            0          5m
````