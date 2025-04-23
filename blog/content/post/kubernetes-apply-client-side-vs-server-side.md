---
title: "Kubernetes Apply: Client-Side vs. Server-Side - Choosing the Right Strategy"
date: 2025-05-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "kubectl apply", "Client-Side Apply", "Server-Side Apply", "ResourceVersion", "Field Ownership", "GitOps"]
categories:
  - Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Understand the differences between Kubernetes client-side and server-side apply strategies, and learn when to use each approach for effective configuration management in collaborative environments."
more_link: "yes"
url: "/kubernetes-apply-client-side-vs-server-side/"
---

Explore the nuances of `kubectl apply`, including client-side and server-side strategies, to optimize configuration management and prevent conflicts in Kubernetes.

<!--more-->

# Kubernetes Apply: Client-Side vs. Server-Side

## Section 1: The Configuration Management Challenge in Kubernetes

In the dynamic world of Kubernetes, resources are constantly being created, updated, and managed by diverse teams and systems. This constant flux raises a crucial question: how can we ensure consistent and conflict-free configuration management?

If you've ever heard a DevOps team member exclaim, "Who changed my config?!" you understand the importance of Kubernetes apply strategies. Let's dive into the real-world differences between client-side and server-side apply in Kubernetes and explore when to use each approach for maximum effectiveness.

## Section 2: Client-Side Apply: A Familiar Approach

Think of client-side apply as editing a document with track changes. The editor (`kubectl`) keeps a snapshot of the configuration from the last time you applied it.

### How it Works in Practice

Let's consider a simple Nginx deployment:

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
        - name: nginx
          image: nginx:1.25.1
          ports:
            - containerPort: 80
```

When you run `kubectl apply -f deployment.yaml`, Kubernetes performs the following steps:

1.  **Checks for Existence:** Determines if the resource already exists.
2.  **Creates or Annotates:** If new, creates the resource and adds an annotation with the full configuration.
3.  **Compares and Patches:** If it exists, compares the file content with the annotation.
4.  **Sends Changes:** Builds a list of necessary changes and sends them to the cluster.

You can view the annotation with:

```bash
kubectl get deployment nginx-deployment -o yaml | grep last-applied
```

This annotation contains the "track changes" history:

```text
kubectl.kubernetes.io/last-applied-configuration: {\"apiVersion\":\"apps/v1\",\"kind\":\"Deployment\",...}
```

### The Pitfalls of Client-Side Apply

Client-side apply can lead to problems in collaborative environments. Consider two teams, Team A and Team B, managing the same deployment.

*   **Team A's Version (Resource Requests):**

    ```yaml
    spec:
      template:
        spec:
          containers:
          - name: app
            resources:
              requests:
                memory: "512Mi"
                cpu: "250m"
              limits:
                memory: "1Gi"
                cpu: "500m"
    ```

*   **Team B's Version (Performance Tuning):**

    ```yaml
    spec:
      template:
        spec:
          containers:
          - name: app
            resources:
              requests:
                memory: "2Gi"
                cpu: "1000m"
    ```

When Team B runs `kubectl apply`, their version doesn't include resource limits. The result? The limits are removed, potentially causing the application to consume excessive resources.

Client-side apply lacks the concept of partial management; it's an all-or-nothing approach for the included fields.

## Section 3: ResourceVersion: Kubernetes' Concurrency Control

Before exploring server-side apply, it's essential to understand `ResourceVersion`, Kubernetes' mechanism for managing concurrent updates and preventing the "lost update" problem.

### What is ResourceVersion?

Every Kubernetes resource has a `metadata.resourceVersion` field, representing the internal version of the object when last retrieved. It acts as a concurrency token for optimistic concurrency control.

Example:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
  resourceVersion: "238471"
  ...
```

This number changes with each modification, reflecting the internal versioning in etcd storage.

### How ResourceVersion Works

When updating a resource, Kubernetes checks:

1.  **Version Comparison:** Compares the `ResourceVersion` in your update request with the current `ResourceVersion` in storage.
2.  **Update or Reject:** If they match, the update proceeds with a new `ResourceVersion`. If they don't match, the update is rejected with a conflict error.

This prevents scenarios where simultaneous updates overwrite each other's changes without awareness.

### ResourceVersion in Client-Side Apply

In client-side apply, `kubectl` automatically handles `ResourceVersion`:

1.  **Gets Current Version:** Retrieves the current version of the resource (including `ResourceVersion`).
2.  **Builds Patch:** Creates a patch based on your local file and the `last-applied-configuration`.
3.  **Submits Patch:** Submits the patch with the retrieved `ResourceVersion`.
4.  **Retries on Conflict:** If another update occurred in the meantime, `kubectl` receives a conflict error and automatically retries with the new `ResourceVersion`.

This approach works well for simple cases but struggles when multiple tools manage the same resource because it only prevents concurrent updates, not conflicting changes to different fields.

### Example of ResourceVersion in Action

*   **Terminal 1:**

    ```bash
    kubectl get deployment nginx-deployment -o yaml > deployment1.yaml
    # Edit deployment1.yaml to change replicas to 5
    ```

*   **Terminal 2 (while Terminal 1 is editing):**

    ```bash
    kubectl get deployment nginx-deployment -o yaml > deployment2.yaml
    # Edit deployment2.yaml to change replicas to 3
    kubectl apply -f deployment2.yaml
    # This succeeds and changes the ResourceVersion
    ```

*   **Terminal 1 (continuing):**

    ```bash
    kubectl apply -f deployment1.yaml
    # This initially fails with a conflict error, but kubectl automatically retries
    ```

`ResourceVersion` ensures sequential updates but doesn't address field ownership conflicts, which is where server-side apply comes in.

## Section 4: Server-Side Apply: Collaborative Configuration Management

Server-side apply is akin to a collaborative document with multiple editors, each "owning" specific sections. Attempting to edit another's section results in a warning.

### Real-World Usage

Revisiting the Nginx example with server-side apply:

```bash
kubectl apply -f deployment.yaml --server-side --field-manager=deployment-team
```

The `--field-manager` flag is essential, acting as your signature on specific configuration parts.

Now, suppose the security team wants to add security contexts:

```yaml
# security-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  template:
    spec:
      securityContext:
        runAsUser: 1000
        fsGroup: 2000
      containers:
      - name: nginx
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
```

They can apply it with:

```bash
kubectl apply -f security-patch.yaml --server-side --field-manager=security-team
```

The result:

*   The `deployment-team` manages `replicas`, `selectors`, `image`, and `ports`.
*   The `security-team` manages `securityContexts`.

Each team can update their portion without conflict.

### ResourceVersion in Server-Side Apply

Server-side apply still uses `ResourceVersion` for concurrency control but adds field management.

1.  **ResourceVersion Check:** The API server checks the `ResourceVersion`.
2.  **Conflict Detection:** If a concurrency conflict exists (`ResourceVersion` mismatch), the request is rejected. If there's no concurrency conflict, but a field ownership conflict exists, a specific error appears.

You can then resolve conflicts through coordination or by using `--force-conflicts`.

This dual-layer protection provides optimistic concurrency control and field-level conflict detection.

### Example:

*   **Team A owns the `replicas` field:**

    ```bash
    kubectl apply -f deployment-team-a.yaml --server-side --field-manager=team-a
    ```

*   **Team B attempts to change `replicas`:**

    ```bash
    kubectl apply -f deployment-team-b.yaml --server-side --field-manager=team-b
    ```

If no `ResourceVersion` conflict exists, but Team B's file includes `replicas`, an error occurs:

```text
Error: Apply failed with 1 conflict: conflict with \"team-a\": .spec.replicas
```

Team B can force the change with:

```bash
kubectl apply -f deployment-team-b.yaml --server-side --field-manager=team-b --force-conflicts
```

This transfers ownership of `replicas` from Team A to Team B.

### ResourceVersion vs. Field Ownership

`ResourceVersion` and field ownership address different but complementary challenges:

*   `ResourceVersion` prevents multiple actors from making conflicting updates concurrently (concurrency control).
*   Field ownership (in server-side apply) prevents multiple actors from accidentally overwriting each other's fields, even when updates occur at different times (field-level conflict detection).

### Viewing Field Ownership

`managedFields` information isn't shown by default. Use the `--show-managed-fields` flag:

```bash
kubectl get deployment my-deployment -o yaml --show-managed-fields
```

This displays the `managedFields` section, indicating which managers own which fields:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-deployment
  resourceVersion: "123456"
  managedFields:
  - manager: kubectl-client-side-apply
    operation: Update
    apiVersion: apps/v1
    time: "2025-02-20T14:30:15Z"
    fieldsV1:
      f:metadata:
        f:annotations:
          f:kubectl.kubernetes.io/last-applied-configuration: {}
      # other fields...
  - manager: security-team
    operation: Apply
    apiVersion: apps/v1
    time: "2025-02-21T09:15:30Z"
    fieldsV1:
      f:spec:
        f:template:
          f:spec:
            f:securityContext: {}
            # other security fields...
```

This information aids in troubleshooting ownership conflicts.

### Server-Side Apply Availability

Server-side apply is generally available (GA) and enabled by default in Kubernetes 1.22+, but you must still explicitly use the `--server-side` flag with `kubectl`. Client-side apply remains the default behavior without additional flags.

## Section 5: Real-World Scenarios

### Two Teams Scenario

In many organizations, platform and application teams collaborate on the same resources. The platform team manages a central ConfigMap with shared settings:

```yaml
# platform-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: shared-config
data:
  database.url: "jdbc:postgresql://prod-db:5432/myapp"
  cache.url: "redis://redis-master:6379"
  log.level: "INFO"
  metrics.enabled: "true"
```

The application team adds their settings:

```yaml
# app-specific.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: shared-config
data:
  app.timeout: "30s"
  app.retries: "3"
  feature.new-ui: "false"
```

With client-side apply, the last applied configuration wins, erasing the other team's settings.

With server-side apply:

```bash
kubectl apply -f platform-configmap.yaml --server-side --field-manager=platform

kubectl apply -f app-specific.yaml --server-side --field-manager=app-team
```

`ResourceVersion` prevents concurrent updates, and field ownership prevents accidental field overwrites, resulting in a unified ConfigMap.

### The Dreaded List Merge Problem

Client-side apply struggles with list merging. Consider a Deployment with multiple containers:

```yaml
# team1.yaml
spec:
  template:
    spec:
      containers:
      - name: app
        image: myapp:1.0
      - name: sidecar
        image: sidecar:1.0
```

Another team updates the sidecar:

```yaml
# team2.yaml
spec:
  template:
    spec:
      containers:
      - name: sidecar
        image: sidecar:2.0
        resources:
          limits:
            memory: "256Mi"
```

Client-side apply replaces the entire `containers` list, removing the `app` container. Server-side apply, using the `name` field, correctly updates the `sidecar` container.

## Section 6: Choosing the Right Approach

*   **Use Client-Side Apply when:**

    *   You're the sole manager of a resource.
    *   You're using older clusters (pre-1.22).
    *   You're dealing with simple resources.
    *   `ResourceVersion` is sufficient for conflict prevention.

*   **Use Server-Side Apply when:**

    *   Multiple teams or controllers update the same resources.
    *   You're working with complex resources.
    *   You want to prevent accidental field overwrites.
    *   You need sophisticated conflict resolution.

## Section 7: Practical Tips

*   Use server-side apply for resources managed by multiple teams or controllers/operators.
*   Use meaningful field manager names.
*   Document field ownership in your internal wiki.
*   Establish standards for field manager naming.
*   Train your team on conflict resolution.

## Section 8: Real-World Example: GitOps with Multiple Teams

Consider an environment with:

*   An infrastructure team managing base deployments via GitOps.
*   A security team applying security policies.
*   A networking team managing service configurations.
*   Application teams deploying their code.

They can collaborate with server-side apply:

1.  **Infrastructure Team:**

    ```yaml
    # infrastructure/base-deployment.yaml
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: payment-service
    spec:
      replicas: 3
      selector:
        matchLabels:
          app: payment-service
    template:
      metadata:
        labels:
          app: payment-service
      spec:
        containers:
        - name: payment-app
          image: payment-service:1.0
          ports:
            - containerPort: 8080
    ```

    ```bash
    kubectl apply -f infrastructure/base-deployment.yaml --server-side --field-manager=infra-gitops
    ```

2.  **Security Team:**

    ```yaml
    # security/payment-security.yaml
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: payment-service
    spec:
      template:
        spec:
          securityContext:
            runAsNonRoot: true
            seccompProfile:
              type: RuntimeDefault
          containers:
          - name: payment-app
            securityContext:
              allowPrivilegeEscalation: false
              readOnlyRootFilesystem: true
              capabilities:
                drop:
                - ALL
    ```

    ```bash
    kubectl apply -f security/payment-security.yaml --server-side --field-manager=security-policies
    ```

3.  **Application Team:**

    ```yaml
    # app-team/payment-app-config.yaml
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: payment-service
    spec:
      template:
        spec:
          containers:
          - name: payment-app
            image: payment-service:1.1
            env:
            - name: PAYMENT_API_KEY
              valueFrom:
                secretKeyRef:
                  name: payment-secrets
                  key: api-key
            - name: LOG_LEVEL
              value: "INFO"
    ```

    ```bash
    kubectl apply -f app-team/payment-app-config.yaml --server-side --field-manager=payment-team
    ```

In this scenario:

*   `ResourceVersion` prevents simultaneous updates.
*   Field ownership ensures each team manages their part of the configuration.

### Examining ResourceVersion and Field Ownership

```bash
kubectl get deployment payment-service -o yaml --show-managed-fields
```

The output shows:

*   The `ResourceVersion` (a single incrementing number).
*   The `managedFields` section tracking field ownership.

## Section 9: Conclusion

Server-side apply reflects modern team workflows in Kubernetes. `ResourceVersion` and field ownership play vital roles:

*   `ResourceVersion` prevents concurrent changes from overwriting each other.
*   Field ownership enables teams to safely manage their resource portions.

While server-side apply is available by default in Kubernetes 1.22+, you must explicitly opt-in using `--server-side`.

For simple cases, client-side apply with `ResourceVersion` may suffice. However, as Kubernetes usage becomes more complex, server-side apply's field-level tracking becomes invaluable.
