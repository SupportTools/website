+++
Categories = ["kubernetes", "opa gatekeeper"]
Tags = ["kubernetes", "opa", "gatekeeper", "opa gatekeeper"]
date = "2021-06-11T01:11:00+00:00"
more_link = "yes"
title = "How to use OPA Gatekeeper to require a label on all namespaces."
+++

By default, Kubernetes will create namespaces without any labels. This can tracking the owner of the namespace difcult. Also, by having all namespaces labeled. You can use labels for running show-back and charge-back reports based on owner labels.

<!--more-->
# [Pre-requisites](#pre-requisites)

- kubectl access to cluster with admin permissions

# [Installation](#install)

- For Rancher environments, please see [Doc](https://rancher.com/docs/rancher/v2.5/en/opa-gatekeper/) for installation steps.
- For Non-Rancher environments, please see [Doc](https://open-policy-agent.github.io/gatekeeper/website/docs/install/)

# [Creating policy](#policy)

- Create a file named `constraint_template.yaml` with the following content:
```
apiVersion: templates.gatekeeper.sh/v1beta1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    description: Requires all resources to contain a specified label with a value
      matching a provided regular expression.
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        # Schema for the `parameters` field
        openAPIV3Schema:
          properties:
            message:
              type: string
            labels:
              type: array
              items:
                type: object
                properties:
                  key:
                    type: string
                  allowedRegex:
                    type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        get_message(parameters, _default) = msg {
          not parameters.message
          msg := _default
        }

        get_message(parameters, _default) = msg {
          msg := parameters.message
        }

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_].key}
          missing := required - provided
          count(missing) > 0
          def_msg := sprintf("you must provide labels: %v", [missing])
          msg := get_message(input.parameters, def_msg)
        }

        violation[{"msg": msg}] {
          value := input.review.object.metadata.labels[key]
          expected := input.parameters.labels[_]
          expected.key == key
          # do not match if allowedRegex is not defined, or is an empty string
          expected.allowedRegex != ""
          not re_match(expected.allowedRegex, value)
          def_msg := sprintf("Label <%v: %v> does not satisfy allowed regex: %v", [key, value, expected.allowedRegex])
          msg := get_message(input.parameters, def_msg)
        }
```

- Then apply the ConstraintTemplate to the cluster by running:
```
kubectl apply -f constraint_template.yaml
```

- Create a file named `constraint.yaml` with the following content:
```
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: all-must-have-owner
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Namespace"]
  parameters:
    message: "All namespaces must have an `owner` label"
    labels:
      - key: owner
```

- Then, apply the Constraint to the cluster by running:
```
kubectl apply -f constraint.yaml
```

# [Test the policy](#test)

To test that our new policy is working correctly, we're going to try deploying two files. `allowed.yaml` should work with `disallowed.yaml` being blocked.

- Create a file named `allowed.yaml` with the following content:
```
apiVersion: v1
kind: Namespace
metadata:
  name: allowed-namespace
  labels:
    owner: mmattox

```

- Create a file named `disallowed.yaml` with the following content:
```
apiVersion: v1
kind: Namespace
metadata:
  name: disallowed-namespace
```

- Then, create the allowed pod to the cluster by running:
```
kubectl apply -f allowed.yaml
```

- We should see the following output:
```
namespace/allowed-namespace created
```

- Then, create the disallowed pod to the cluster by running:
```
kubectl apply -f disallowed.yaml
```

- We should see the following output:
```
Error from server ([denied by all-must-have-owner] All namespaces must have an `owner` label): error when creating "example_disallowed.yaml": admission webhook "validation.gatekeeper.sh" denied the request: [denied by all-must-have-owner] All namespaces must have an `owner` label
```