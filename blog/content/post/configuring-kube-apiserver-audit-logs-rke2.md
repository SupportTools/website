---
title: "Configuring Kube-apiserver Audit Logs in RKE2"
date: 2024-09-11T19:26:00-05:00
draft: false
tags: ["RKE2", "Kube-apiserver", "Audit Logging", "Kubernetes"]  
categories:  
- RKE2  
- Troubleshooting  
- Kubernetes  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn how to configure kube-apiserver audit logs in RKE2 with basic and detailed examples to monitor Kubernetes API actions for troubleshooting and security."  
more_link: "yes"  
url: "/rke2-kube-apiserver-audit-logs-configuration/"  
---

Audit logs in Kubernetes are vital in monitoring and securing your cluster. They help you track API requests, identify configuration changes, and trace actions to their source. In RKE2 (Rancher Kubernetes Engine 2), you can configure **kube-apiserver audit logs** to capture high-level and detailed information about what happens in your cluster.

In this post, we'll walk through how to set up basic and detailed audit logging for the kube-apiserver in RKE2, providing examples to help you monitor API activities effectively.

<!--more-->

### Why Enable Audit Logs in RKE2?

Audit logs allow administrators to gain visibility into the following areas:

- **Security Monitoring**: Detect unauthorized access or privilege escalation.
- **Troubleshooting**: Track down the source of configuration changes or failed deployments.
- **Compliance**: Ensure audit trails are in place for regulatory requirements.

With audit logs enabled, you can log actions such as pod creation, role updates, and API requests, providing an invaluable trail of events for troubleshooting or investigating suspicious behavior.

---

## Configuring Kube-apiserver Audit Logs in RKE2

### Step 1: Prepare the RKE2 Configuration

To enable audit logging in RKE2, you'll need to modify the **RKE2 configuration file** (`/etc/rancher/rke2/config.yaml`). The audit log can be configured to capture either **basic** or **detailed** information, depending on your needs.

Here's how you can get started:

### Step 2: Create an Audit Policy File

An **audit policy controls audit logs** that defines what actions get logged and at what level of detail. The audit policy is stored in a YAML file and governs the events logged by the kube-apiserver.

#### Example: Basic Audit Policy

For a basic audit policy, you can log minimal metadata about key resources like pods, services, and roles. This is useful when you want to keep logs small but still capture essential events.

"`yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
 - level: Metadata
    resources:
 - group:"  "
      resources: ["pods", "services"]
 - level: RequestResponse
    resources:
 - group: "rbac.authorization.k8s.io"
      resources: ["roles", "rolebindings"]
```

In this example:

- **Metadata** logging is applied to pods and services, capturing basic action information.
- **RequestResponse** logging is applied to RBAC resources, capturing detailed request and response data for role and rolebinding changes.

Save this file as `/etc/rancher/rke2/audit-policy.yaml`.

#### Example: Detailed Audit Policy

For more comprehensive logging, you can use a detailed audit policy that captures request and response data for a wide range of Kubernetes resources. This is useful for environments requiring strict security monitoring or regulatory compliance.

"`yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
 - level: RequestResponse
    resources:
 - group:"  "
      resources: ["pods", "services", "configmaps", "secrets"]
 - level: RequestResponse
    resources:
 - group: "apps"
      resources: ["deployments", "statefulsets", "daemonsets"]
 - level: RequestResponse
    resources:
 - group: "rbac.authorization.k8s.io"
      resources: ["roles", "rolebindings"]
 - level: Metadata
    resources:
 - group: "authentication.k8s.io"
      resources: ["tokenreviews"]
 - level: None
    users: ["system:serviceaccount:kube-system:default"]
```

This detailed policy logs:

- Full **request and response** data for pods, services, configmaps, secrets, deployments, and RBAC resources.
- Metadata for token authentication reviews.
- Excludes (`None` level) logging for the default service account in the kube-system namespace to reduce noise.

### **Important: Avoid Capturing Secrets**

When configuring detailed logging, it's crucial to avoid inadvertently capturing sensitive data like secrets or private keys. For instance, logging request and response data for Kubernetes **Secrets** or **ConfigMaps** that store confidential information could expose sensitive credentials in your audit logs.

To avoid capturing secrets, you can modify your audit policy to either **exclude secrets** from being logged or limit logging to metadata only:

"`yaml
- level: Metadata
  resources:
 - group:"  "
    resources: ["secrets", "configmaps"]
```

This configuration logs only the metadata (e.g., timestamps, user, and action) for Secrets and ConfigMaps, ensuring that sensitive data such as Secrets' contents is not logged.

### Step 3: Modify the RKE2 Config File

Now that you have an audit policy file reference it in the RKE2 configuration file (`/etc/rancher/rke2/config.yaml`).

"`yaml
kube-apiserver-arg:
 - "--audit-log-path=/var/log/kubernetes/audit/audit.log"
 - "--audit-policy-file=/etc/rancher/rke2/audit-policy.yaml"
 - "--audit-log-maxage=30"
 - "--audit-log-maxbackup=10"
 - "--audit-log-maxsize=100"
```

Explanation of the flags:

- `--audit-log-path`: Defines where the audit log will be stored on the server.
- `--audit-policy-file`: Points to the audit policy file you created.
- `--audit-log-maxage`: Maximum days to retain audit logs.
- `--audit-log-maxbackup`: Maximum number of old audit log files to retain.
- `--audit-log-maxsize`: Maximum size in megabytes of the audit log file before it's rolled over.

Once you've updated the config file, restart the RKE2 service to apply the changes:

"`bash
sudo systemctl restart rke2-server
```

---

## Example Audit Logs

After enabling audit logging, you'll see logs generated based on your policy. Let's look at some examples of audit logs that capture different levels of detail.

### Basic Audit Log Entry

Here's an example of a basic audit log entry capturing metadata for a pod creation event:

"`json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "Metadata",
  "timestamp": "2024-09-11T12:30:45Z",
  "user": {
    "username": "system:serviceaccount:default:default",
    "groups": ["system:serviceaccounts", "system:authenticated"]
 },
  "verb": "create",
  "objectRef": {
    "resource": "pods",
    "name": "nginx-pod",
    "namespace": "default"
 },
  "sourceIPs": ["10.0.0.15"],
  "responseStatus": {
    "code": 201
 }
}
```

This log captures:

- The **user** who created the pod (`system:serviceaccount:default`).
- The **action** (verb) performed is `create`.
- The **resource** affected is a pod named `nginx-pod` in the `default` namespace.

### Detailed Audit Log Entry

Here's an example of a more detailed audit log entry with request and response data for a rolebinding update:

"`json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "RequestResponse",
  "timestamp": "2024-09-11T14:25:34Z",
  "user": {
    "username": "admin",
    "groups": ["system:authenticated"]
 },
  "verb": "update",
  "objectRef": {
    "resource": "rolebindings",
    "namespace": "kube-system",
    "name": "admin-binding"
 },
  "sourceIPs": ["192.168.1.100"],
  "responseStatus": {
    "code": 200
 },
  "requestObject": {
    "apiVersion": "rbac.authorization.k8s.io/v1",
    "kind": "RoleBinding",
    "metadata": {
      "name": "admin-binding",
      "namespace": "kube-system"
 },
    "roleRef": {
      "kind": "ClusterRole",
      "name": "cluster-admin",
      "apiGroup": "rbac.authorization.k8s.io"
 },
    "subjects": [
 {
        "kind": "User",
        "name": "admin",
        "apiGroup": "rbac.authorization.k8s.io"
 }
 ]
 },
  "responseObject": {
    "apiVersion": "rbac.authorization.k8s.io/v1",
    "kind": "RoleBinding",
    "metadata": {
      "name": "admin-binding",
     

 "namespace": "kube-system"
 }
 }
}
```

This detailed log entry captures:

- The complete **request object**, shows that the `admin-binding` rolebinding was updated to use the `cluster-admin` role.
- The **user** who initiated the action is `admin`.
- The response indicates that the update was successful with a `200` status code.

---

## Best Practices for Audit Log Management

- **Retention and Rotation**: Ensure proper log rotation policies (e.g., `--audit-log-maxage`, `--audit-log-maxbackup`) to avoid filling up disk space.
- **Centralize Logs**: Use a log aggregation tool such as **Loki** or **Elasticsearch** to centralize your audit logs for easier search and analysis.
Alerting: Use monitoring tools integrated with your log system to set up alerts for suspicious or critical actions, such as role changes.

---

### Conclusion

Configuring audit logging in RKE2 allows you to gain critical visibility into what's happening in your Kubernetes cluster. Whether you need basic logging to capture key events or detailed logging for in-depth security monitoring, configuring the **kube-apiserver** audit logs with the right policy is essential. Remember to avoid logging sensitive information such as secrets to ensure your logs don't expose confidential data.

Setting up proper audit logs can help you troubleshoot issues, enhance security, and ensure compliance in your RKE2 environment.

Now that you know how to configure basic and detailed audit logging, start setting up your policies to monitor and secure your Kubernetes clusters!
