---
title: "Kubernetes Tekton Triggers: GitHub Webhooks and Event-Driven CI Pipelines"
date: 2029-02-11T00:00:00-05:00
draft: false
tags: ["Tekton", "Kubernetes", "CI/CD", "GitHub", "Webhooks", "GitOps"]
categories:
- Kubernetes
- CI/CD
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Tekton Triggers for GitHub webhook-driven CI pipelines, covering EventListeners, TriggerBindings, TriggerTemplates, interceptors, and multi-repository pipeline routing in enterprise Kubernetes environments."
more_link: "yes"
url: "/kubernetes-tekton-triggers-github-webhooks-event-driven-ci/"
---

Tekton Triggers extends the Tekton pipeline system to respond to external events—GitHub webhooks, GitLab events, container registry pushes, or custom HTTP payloads. Where Tekton Pipelines define *what* to run, Triggers defines *when* to run it and *how* to extract the parameters that configure each run. The result is a fully Kubernetes-native, declarative CI system where pipeline executions are triggered by real-world events without requiring a separate CI server.

This guide covers the complete Tekton Triggers stack: installing the components, configuring GitHub webhook delivery, writing secure interceptor chains, binding event payloads to pipeline parameters, and operating a multi-repository pipeline router at production scale.

<!--more-->

## Tekton Triggers Architecture

Tekton Triggers introduces four CRDs that work together to process incoming events:

| Resource | Purpose |
|----------|---------|
| `EventListener` | HTTP server that receives webhook POST requests |
| `TriggerBinding` | Extracts fields from the event payload (CEL expressions) |
| `TriggerTemplate` | Parameterized template for PipelineRun/TaskRun creation |
| `ClusterTriggerBinding` | Like TriggerBinding but cluster-scoped (reusable) |

```
GitHub Push Event
        │
        ▼
   EventListener (port 8080)
        │
   ┌────┴──────────────┐
   │  Interceptor Chain │
   │  1. GitHub HMAC   │
   │  2. CEL filter    │
   └────────┬──────────┘
            │  (filtered events pass through)
            ▼
   TriggerBinding      ← extracts repo, branch, commit SHA
            │
            ▼
   TriggerTemplate     ← instantiates PipelineRun with extracted params
            │
            ▼
      PipelineRun      ← executes the build pipeline
```

## Installing Tekton Pipelines and Triggers

```bash
# Install Tekton Pipelines
kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml

# Install Tekton Triggers
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/release.yaml

# Install Tekton Triggers Interceptors
kubectl apply -f https://storage.googleapis.com/tekton-releases/triggers/latest/interceptors.yaml

# Verify all pods are running
kubectl -n tekton-pipelines get pods
# tekton-pipelines-controller-xxx   1/1   Running
# tekton-pipelines-webhook-xxx      1/1   Running
# tekton-triggers-controller-xxx    1/1   Running
# tekton-triggers-webhook-xxx       1/1   Running
# tekton-triggers-core-interceptors-xxx 1/1 Running
```

## Creating the Pipeline

Before setting up triggers, define the Pipeline that will be invoked. This example builds a Go application, runs tests, and pushes an OCI image.

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: go-build-test-push
  namespace: ci-system
spec:
  params:
    - name: repo-url
      type: string
      description: Git repository URL
    - name: revision
      type: string
      description: Git revision (SHA or branch)
    - name: image-ref
      type: string
      description: Full image reference including tag
    - name: context-dir
      type: string
      default: "."

  workspaces:
    - name: source
    - name: dockerconfig

  tasks:
    - name: clone
      taskRef:
        resolver: hub
        params:
          - name: catalog
            value: tekton-catalog-tasks
          - name: type
            value: artifact
          - name: kind
            value: task
          - name: name
            value: git-clone
          - name: version
            value: "0.9"
      workspaces:
        - name: output
          workspace: source
      params:
        - name: url
          value: $(params.repo-url)
        - name: revision
          value: $(params.revision)
        - name: depth
          value: "1"

    - name: unit-test
      runAfter: [clone]
      taskRef:
        name: go-test
      workspaces:
        - name: source
          workspace: source
      params:
        - name: context-dir
          value: $(params.context-dir)
        - name: packages
          value: ./...

    - name: build-push
      runAfter: [unit-test]
      taskRef:
        resolver: hub
        params:
          - name: name
            value: kaniko
          - name: version
            value: "0.6"
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
      params:
        - name: IMAGE
          value: $(params.image-ref)
        - name: CONTEXT
          value: $(params.context-dir)
        - name: EXTRA_ARGS
          value:
            - --cache=true
            - --cache-repo=registry.prod.example.com/cache
            - --compressed-caching=false
```

## Configuring GitHub Webhook Security

Create an HMAC secret for webhook validation.

```bash
# Generate a strong random secret
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "Webhook secret: ${WEBHOOK_SECRET}"

# Store in Kubernetes secret
kubectl -n ci-system create secret generic github-webhook-secret \
  --from-literal=secret="${WEBHOOK_SECRET}"

# Store in 1Password / Vault / SSM for safekeeping
# Then configure the GitHub webhook:
# Settings → Webhooks → Add webhook
# Payload URL: https://tekton-triggers.ci.example.com
# Content type: application/json
# Secret: <the value from WEBHOOK_SECRET>
# Events: Push events, Pull request events
```

## EventListener with Interceptor Chain

The EventListener processes incoming webhooks. This configuration handles push events and pull requests, routing them to different pipelines.

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: github-listener
  namespace: ci-system
spec:
  serviceAccountName: tekton-triggers-sa
  resources:
    kubernetesResource:
      spec:
        template:
          spec:
            containers:
              - resources:
                  requests:
                    cpu: 100m
                    memory: 128Mi
                  limits:
                    cpu: 500m
                    memory: 512Mi
  triggers:
    # Trigger 1: main/release branch push → full build+push
    - name: push-main-branch
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret
            - name: eventTypes
              value: ["push"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: |
                body.ref.startsWith('refs/heads/main') ||
                body.ref.startsWith('refs/heads/release/')
            - name: overlays
              value:
                - key: branch
                  expression: "body.ref.split('/')[2]"
                - key: short_sha
                  expression: "body.head_commit.id.truncate(8)"
                - key: image_tag
                  expression: "body.ref.split('/')[2] + '-' + body.head_commit.id.truncate(8)"
      bindings:
        - ref: github-push-binding
      template:
        ref: build-push-template

    # Trigger 2: pull request → test only (no push)
    - name: pull-request-test
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret
            - name: eventTypes
              value: ["pull_request"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: |
                body.action in ['opened', 'synchronize', 'reopened']
            - name: overlays
              value:
                - key: branch
                  expression: "body.pull_request.head.ref"
                - key: short_sha
                  expression: "body.pull_request.head.sha.truncate(8)"
      bindings:
        - ref: github-pr-binding
      template:
        ref: pr-test-template

    # Trigger 3: tag push → release build
    - name: tag-push-release
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret
            - name: eventTypes
              value: ["push"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: "body.ref.startsWith('refs/tags/v')"
            - name: overlays
              value:
                - key: tag_name
                  expression: "body.ref.split('/')[2]"
      bindings:
        - ref: github-tag-binding
      template:
        ref: release-template
```

## TriggerBindings

TriggerBindings extract fields from the event payload and make them available as Tekton parameters.

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-push-binding
  namespace: ci-system
spec:
  params:
    - name: git-repo-url
      value: $(body.repository.clone_url)
    - name: git-revision
      value: $(body.head_commit.id)
    - name: git-repo-name
      value: $(body.repository.name)
    - name: git-repo-owner
      value: $(body.repository.owner.name)
    - name: branch
      value: $(extensions.branch)
    - name: short-sha
      value: $(extensions.short_sha)
    - name: image-tag
      value: $(extensions.image_tag)
    - name: pusher-name
      value: $(body.pusher.name)
---
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-pr-binding
  namespace: ci-system
spec:
  params:
    - name: git-repo-url
      value: $(body.pull_request.head.repo.clone_url)
    - name: git-revision
      value: $(body.pull_request.head.sha)
    - name: git-repo-name
      value: $(body.repository.name)
    - name: pr-number
      value: $(body.pull_request.number)
    - name: branch
      value: $(extensions.branch)
    - name: short-sha
      value: $(extensions.short_sha)
---
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerBinding
metadata:
  name: github-tag-binding
  namespace: ci-system
spec:
  params:
    - name: git-repo-url
      value: $(body.repository.clone_url)
    - name: git-revision
      value: $(body.head_commit.id)
    - name: git-repo-name
      value: $(body.repository.name)
    - name: tag-name
      value: $(extensions.tag_name)
```

## TriggerTemplates

TriggerTemplates instantiate PipelineRun objects with the parameters extracted by TriggerBindings.

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: build-push-template
  namespace: ci-system
spec:
  params:
    - name: git-repo-url
    - name: git-revision
    - name: git-repo-name
    - name: branch
    - name: short-sha
    - name: image-tag
    - name: pusher-name
      default: "automated"

  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        generateName: build-$(tt.params.git-repo-name)-
        namespace: ci-system
        labels:
          app.kubernetes.io/managed-by: tekton-triggers
          triggers.tekton.dev/trigger: push-main-branch
          ci.example.com/repo: $(tt.params.git-repo-name)
          ci.example.com/branch: $(tt.params.branch)
          ci.example.com/sha: $(tt.params.short-sha)
        annotations:
          ci.example.com/triggered-by: $(tt.params.pusher-name)
      spec:
        timeouts:
          pipeline: 30m
          tasks: 25m
        pipelineRef:
          name: go-build-test-push
        params:
          - name: repo-url
            value: $(tt.params.git-repo-url)
          - name: revision
            value: $(tt.params.git-revision)
          - name: image-ref
            value: registry.prod.example.com/$(tt.params.git-repo-name):$(tt.params.image-tag)
        workspaces:
          - name: source
            volumeClaimTemplate:
              spec:
                accessModes: [ReadWriteOnce]
                resources:
                  requests:
                    storage: 2Gi
                storageClassName: fast-ssd
          - name: dockerconfig
            secret:
              secretName: registry-credentials
---
apiVersion: triggers.tekton.dev/v1beta1
kind: TriggerTemplate
metadata:
  name: pr-test-template
  namespace: ci-system
spec:
  params:
    - name: git-repo-url
    - name: git-revision
    - name: git-repo-name
    - name: pr-number
    - name: branch
    - name: short-sha

  resourcetemplates:
    - apiVersion: tekton.dev/v1
      kind: PipelineRun
      metadata:
        generateName: pr-$(tt.params.git-repo-name)-$(tt.params.pr-number)-
        namespace: ci-system
        labels:
          app.kubernetes.io/managed-by: tekton-triggers
          ci.example.com/pr-number: $(tt.params.pr-number)
          ci.example.com/repo: $(tt.params.git-repo-name)
      spec:
        timeouts:
          pipeline: 20m
        pipelineRef:
          name: go-test-only
        params:
          - name: repo-url
            value: $(tt.params.git-repo-url)
          - name: revision
            value: $(tt.params.git-revision)
        workspaces:
          - name: source
            volumeClaimTemplate:
              spec:
                accessModes: [ReadWriteOnce]
                resources:
                  requests:
                    storage: 1Gi
                storageClassName: fast-ssd
```

## RBAC for EventListener Service Account

The EventListener service account needs permissions to create pipeline runs and read secrets.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: tekton-triggers-sa
  namespace: ci-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: tekton-triggers-role
  namespace: ci-system
rules:
  - apiGroups: ["triggers.tekton.dev"]
    resources:
      - eventlisteners
      - triggerbindings
      - triggertemplates
      - triggers
      - clusterinterceptors
    verbs: [get, list, watch]
  - apiGroups: ["tekton.dev"]
    resources:
      - pipelineruns
      - taskruns
    verbs: [create, list, get, watch, update, patch]
  - apiGroups: [""]
    resources: [configmaps, secrets, serviceaccounts]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [events]
    verbs: [create, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tekton-triggers-binding
  namespace: ci-system
subjects:
  - kind: ServiceAccount
    name: tekton-triggers-sa
    namespace: ci-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: tekton-triggers-role
---
# ClusterRole binding for ClusterInterceptors
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: tekton-triggers-interceptors-binding
subjects:
  - kind: ServiceAccount
    name: tekton-triggers-sa
    namespace: ci-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: tekton-triggers-interceptors
```

## Exposing the EventListener via Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tekton-triggers-ingress
  namespace: ci-system
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    # GitHub webhooks come from these CIDR ranges
    nginx.ingress.kubernetes.io/whitelist-source-range: |
      192.30.252.0/22,185.199.108.0/22,140.82.112.0/20,143.55.64.0/20
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - tekton-triggers.ci.example.com
      secretName: tekton-triggers-tls
  rules:
    - host: tekton-triggers.ci.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: el-github-listener
                port:
                  number: 8080
```

## Custom CEL Interceptor for Multi-Repository Routing

When a single EventListener handles multiple repositories, a CEL filter routes events to the correct pipeline.

```yaml
apiVersion: triggers.tekton.dev/v1beta1
kind: EventListener
metadata:
  name: multi-repo-listener
  namespace: ci-system
spec:
  serviceAccountName: tekton-triggers-sa
  triggers:
    - name: repo-api-service
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret
            - name: eventTypes
              value: ["push"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: |
                body.repository.full_name == 'myorg/api-service' &&
                body.ref.startsWith('refs/heads/')
      bindings:
        - ref: github-push-binding
      template:
        ref: api-service-build-template

    - name: repo-frontend
      interceptors:
        - ref:
            name: github
            kind: ClusterInterceptor
          params:
            - name: secretRef
              value:
                secretName: github-webhook-secret
                secretKey: secret
            - name: eventTypes
              value: ["push"]
        - ref:
            name: cel
            kind: ClusterInterceptor
          params:
            - name: filter
              value: |
                body.repository.full_name == 'myorg/frontend' &&
                body.ref.startsWith('refs/heads/')
      bindings:
        - ref: github-push-binding
      template:
        ref: frontend-build-template
```

## PipelineRun Cleanup with TTL Controller

Completed PipelineRuns accumulate quickly. Configure automatic cleanup.

```yaml
# Enable the TTL controller in Tekton config
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-tekton-feature-flags
  namespace: tekton-pipelines
data:
  # Automatically prune successful runs after 24h, failed after 48h
  # These are set via the TektonConfig CRD if using the Operator
  keep-pod-on-cancel: "false"
  send-cloudevents-for-runs: "false"

---
# Use a CronJob for cleanup if TTL controller is not available
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pipelinerun-cleanup
  namespace: ci-system
spec:
  schedule: "0 */4 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: pipelinerun-cleanup-sa
          restartPolicy: OnFailure
          containers:
            - name: cleanup
              image: bitnami/kubectl:1.32
              command:
                - /bin/bash
                - -c
                - |
                  # Delete successful PipelineRuns older than 24 hours
                  kubectl -n ci-system get pipelineruns \
                    --field-selector=status.conditions[0].status=True \
                    -o json \
                  | jq -r --arg cutoff "$(date -d '24 hours ago' -Iseconds)" \
                    '.items[] | select(.metadata.creationTimestamp < $cutoff) | .metadata.name' \
                  | xargs -r kubectl -n ci-system delete pipelinerun

                  # Delete failed PipelineRuns older than 48 hours
                  kubectl -n ci-system get pipelineruns \
                    --field-selector=status.conditions[0].status=False \
                    -o json \
                  | jq -r --arg cutoff "$(date -d '48 hours ago' -Iseconds)" \
                    '.items[] | select(.metadata.creationTimestamp < $cutoff) | .metadata.name' \
                  | xargs -r kubectl -n ci-system delete pipelinerun
```

## Monitoring Trigger Activity

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: tekton-triggers-alerts
  namespace: ci-system
spec:
  groups:
    - name: tekton-triggers
      rules:
        - alert: TektonEventListenerDown
          expr: |
            absent(tekton_triggers_event_count_total)
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Tekton EventListener metrics are absent"
        - alert: TektonPipelineRunFailureRate
          expr: |
            rate(tekton_pipelines_controller_pipelinerun_count{status="failed"}[30m]) > 0.5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High PipelineRun failure rate"
            description: "{{ $value | humanize }} failed PipelineRuns per second"
        - alert: TektonWebhookValidationFailures
          expr: |
            increase(tekton_triggers_http_request_count_total{code!="202"}[10m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Tekton EventListener returning non-202 responses"
```

## Debugging Tekton Triggers

```bash
# Check EventListener pod logs
kubectl -n ci-system logs -l eventlistener=github-listener -f

# Check if GitHub payload was received and processed
kubectl -n ci-system get pipelineruns --sort-by=.metadata.creationTimestamp | tail -5

# Inspect a specific PipelineRun
kubectl -n ci-system describe pipelinerun build-myrepo-abc12345-r9fkj

# View task logs in a failed PipelineRun
tkn -n ci-system pipelinerun logs build-myrepo-abc12345-r9fkj -f

# Send a test event manually
curl -X POST https://tekton-triggers.ci.example.com \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -H "X-Hub-Signature-256: sha256=<computed-hmac>" \
  -d @test-push-payload.json

# List recent EventListener activity
kubectl -n ci-system get events \
  --field-selector=involvedObject.kind=EventListener \
  --sort-by='.lastTimestamp'
```

## Summary

Tekton Triggers transforms static pipelines into a fully reactive CI system. By combining GitHub HMAC validation in the interceptor chain, CEL filtering for precise event routing, and parameterized TriggerTemplates, teams can support dozens of repositories from a single EventListener deployment. The patterns in this guide—multi-branch routing, pull request test isolation, tag-driven releases, and automated PipelineRun cleanup—represent the configuration patterns needed for a production-grade Tekton installation that scales from a handful of repositories to a large enterprise monorepo ecosystem.
