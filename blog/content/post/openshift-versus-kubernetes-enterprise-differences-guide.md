---
title: "OpenShift vs Kubernetes: Enterprise Feature Comparison and Migration Guide"
date: 2027-02-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenShift", "Enterprise", "Platform Engineering", "ROSA"]
categories: ["Kubernetes", "Platform Engineering", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison of OpenShift and vanilla Kubernetes for enterprise environments, covering Security Context Constraints, BuildConfig, ImageStream, Routes, OLM, OpenShift Virtualization, managed offerings ROSA and ARO, and migration guidance."
more_link: "yes"
url: "/openshift-versus-kubernetes-enterprise-differences-guide/"
---

Red Hat **OpenShift Container Platform** (OCP) sits on top of Kubernetes and adds a dense layer of enterprise tooling — an opinionated security model, integrated CI/CD, an internal image registry, cluster lifecycle management, and a curated operator marketplace. For many organizations, the question is not whether to use containers, but whether the added structure of OpenShift justifies the licensing cost versus assembling an equivalent stack on vanilla Kubernetes. This guide examines every major difference, maps OpenShift components to their upstream equivalents, and provides concrete migration guidance.

<!--more-->

## OpenShift Architecture Additions

A standard OpenShift 4.x cluster includes several components absent from vanilla Kubernetes:

| Component | OpenShift | Vanilla Kubernetes Equivalent |
|---|---|---|
| Cluster lifecycle | **CVO** (Cluster Version Operator) | Manual or Cluster API |
| Node configuration | **MCO** (Machine Config Operator) | DaemonSet + custom tooling |
| Authentication | **OAuth server** + LDAP/OIDC | Dex, Keycloak, or cloud IdP |
| Internal registry | **OpenShift Image Registry** | Harbor, ECR, GCR |
| HTTP routing | **HAProxy Router (Routes)** | nginx-ingress, Cilium, Contour |
| BuildConfig / S2I | **BuildConfig** | Tekton, Kaniko, Buildpacks |
| Operator lifecycle | **OLM** (Operator Lifecycle Manager) | Helm, manual operator install |
| Security | **SCCs** (Security Context Constraints) | Pod Security Standards, OPA Gatekeeper |
| Virtualization | **OpenShift Virtualization** (KubeVirt) | KubeVirt standalone |
| CI/CD | **OpenShift Pipelines** (Tekton) | Tekton standalone |
| GitOps | **OpenShift GitOps** (ArgoCD) | ArgoCD standalone |

### Cluster Version Operator (CVO)

CVO manages the cluster's own upgrade lifecycle by treating the entire OpenShift platform as a set of versioned operators. The cluster reconciles itself toward the target version declared in the `ClusterVersion` resource.

```yaml
# Check cluster version and upgrade channel
apiVersion: config.openshift.io/v1
kind: ClusterVersion
metadata:
  name: version
spec:
  channel: stable-4.16
  clusterID: "aaaabbbb-cccc-dddd-eeee-ffffgggghhhh"
  # Pin to a specific version; omit to track the channel
  desiredUpdate:
    version: "4.16.8"
```

```bash
# View available updates
oc adm upgrade

# Start upgrade to latest in channel
oc adm upgrade --to-latest=true

# Monitor upgrade progress
oc get clusterversion version -o jsonpath='{.status.conditions}' | jq .
oc get clusteroperators
```

### Machine Config Operator (MCO)

MCO applies OS-level configuration to nodes (kernel arguments, systemd units, file contents) through **MachineConfig** objects without requiring SSH access to nodes. This is the OpenShift equivalent of running Ansible against nodes.

```yaml
# Add a custom kernel argument to all worker nodes
apiVersion: machineconfiguration.openshift.io/v1
kind: MachineConfig
metadata:
  name: 99-worker-hugepages
  labels:
    machineconfiguration.openshift.io/role: worker
spec:
  kernelArguments:
    - hugepagesz=2M
    - hugepages=1024
  config:
    ignition:
      version: 3.4.0
    storage:
      files:
        - path: /etc/sysctl.d/99-hugepages.conf
          mode: 0644
          contents:
            source: "data:,vm.nr_hugepages%3D1024"
---
# Custom systemd unit on control plane nodes
apiVersion: machineconfiguration.openshift.io/v1
kind: MachineConfig
metadata:
  name: 99-master-audit-log
  labels:
    machineconfiguration.openshift.io/role: master
spec:
  config:
    ignition:
      version: 3.4.0
    systemd:
      units:
        - name: audit-log-rotate.service
          enabled: true
          contents: |
            [Unit]
            Description=Rotate audit logs daily
            After=network.target

            [Service]
            Type=oneshot
            ExecStart=/usr/bin/journalctl --vacuum-size=500M
            RemainAfterExit=yes

            [Install]
            WantedBy=multi-user.target
```

## Security Context Constraints vs Pod Security Standards

**Security Context Constraints** (SCCs) are OpenShift's pre-PSP security model. They are more expressive than Kubernetes' **Pod Security Standards** (PSS), supporting per-user and per-service-account policies with fine-grained volume type control.

### SCC comparison table

| Capability | SCC | Pod Security Standards |
|---|---|---|
| User ID range | `runAsUser: MustRunAsRange` | Limited (non-root only) |
| SELinux labels | `seLinuxContext: MustRunAs` | Not configurable |
| Supplemental groups | `supplementalGroups` | Not configurable |
| Volume types | `volumes` whitelist | Not configurable |
| Per-SA binding | `oc adm policy add-scc-to-user` | Namespace-level label |
| Privileged containers | `allowPrivilegedContainer` | `privileged` profile only |

### Custom SCC for a privileged workload

```yaml
# Custom SCC for a monitoring agent that needs host access
apiVersion: security.openshift.io/v1
kind: SecurityContextConstraints
metadata:
  name: monitoring-agent-scc
allowPrivilegedContainer: false
allowPrivilegeEscalation: false
allowedCapabilities:
  - SYS_PTRACE
  - NET_RAW
defaultAddCapabilities: []
requiredDropCapabilities:
  - ALL
allowHostNetwork: true
allowHostPID: true
allowHostIPC: false
allowHostPorts: true
runAsUser:
  type: RunAsAny
seLinuxContext:
  type: RunAsAny
fsGroup:
  type: RunAsAny
supplementalGroups:
  type: RunAsAny
volumes:
  - configMap
  - downwardAPI
  - emptyDir
  - hostPath
  - secret
users:
  - system:serviceaccount:monitoring:node-exporter
groups: []
---
# Grant the SCC to a service account
# oc adm policy add-scc-to-user monitoring-agent-scc \
#   -z node-exporter \
#   -n monitoring
```

### Equivalent PSS + Gatekeeper on vanilla Kubernetes

```yaml
# OPA Gatekeeper ConstraintTemplate equivalent to custom SCC
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedcapabilities
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedCapabilities
      validation:
        type: object
        properties:
          allowedCapabilities:
            type: array
            items:
              type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedcapabilities
        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          capability := container.securityContext.capabilities.add[_]
          not capability_allowed(capability)
          msg := sprintf("Capability %v is not allowed", [capability])
        }
        capability_allowed(cap) {
          allowed := {c | c := input.parameters.allowedCapabilities[_]}
          allowed[cap]
        }
```

## BuildConfig and Source-to-Image (S2I)

**BuildConfig** is OpenShift's built-in build system. It supports Docker, Source-to-Image (S2I), and custom builds, with webhooks that trigger builds on git push. The vanilla Kubernetes equivalent is Tekton Pipelines with Kaniko or Buildpacks.

```yaml
# S2I BuildConfig: build a Python app from source
apiVersion: build.openshift.io/v1
kind: BuildConfig
metadata:
  name: python-api
  namespace: app-team-a
spec:
  source:
    type: Git
    git:
      uri: https://github.com/company/python-api
      ref: main
    contextDir: /
  strategy:
    type: Source
    sourceStrategy:
      from:
        kind: ImageStreamTag
        name: python:3.11
        namespace: openshift
      env:
        - name: PIP_NO_CACHE_DIR
          value: "true"
  output:
    to:
      kind: ImageStreamTag
      name: python-api:latest
  triggers:
    - type: GitHub
      github:
        secret: "github-webhook-secret-replace-me"
    - type: ImageChange
    - type: ConfigChange
  runPolicy: Serial
  resources:
    limits:
      cpu: 2
      memory: 2Gi
    requests:
      cpu: 500m
      memory: 512Mi
```

### Tekton equivalent on vanilla Kubernetes

```yaml
# Tekton Pipeline equivalent to a Docker BuildConfig
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: build-and-push
  namespace: app-team-a
spec:
  params:
    - name: git-url
    - name: git-revision
    - name: image
  workspaces:
    - name: source
    - name: docker-credentials
  tasks:
    - name: clone
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: Task
          - name: name
            value: git-clone
      workspaces:
        - name: output
          workspace: source
      params:
        - name: url
          value: $(params.git-url)
        - name: revision
          value: $(params.git-revision)

    - name: build-push
      runAfter:
        - clone
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: Task
          - name: name
            value: kaniko
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: docker-credentials
      params:
        - name: IMAGE
          value: $(params.image)
        - name: DOCKERFILE
          value: ./Dockerfile
```

## ImageStream and Internal Registry

**ImageStream** is OpenShift's abstraction over container image references. It tracks image tags, enables tag-based triggers, and provides a stable internal reference even when the upstream image URL changes.

```yaml
# Import an external image into an ImageStream
apiVersion: image.openshift.io/v1
kind: ImageStream
metadata:
  name: nginx
  namespace: app-team-a
spec:
  lookupPolicy:
    local: true
  tags:
    - name: "1.25"
      from:
        kind: DockerImage
        name: docker.io/library/nginx:1.25
      importPolicy:
        scheduled: true
        importMode: Legacy
      referencePolicy:
        type: Source
---
# Reference ImageStream tag in a Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: app-team-a
spec:
  template:
    spec:
      containers:
        - name: web
          # OpenShift resolves this internal reference to the actual digest
          image: image-registry.openshift-image-registry.svc:5000/app-team-a/nginx:1.25
```

## Routes vs Ingress vs Gateway API

OpenShift uses **Route** objects by default. The HAProxy-based Router handles TLS termination, path-based routing, and edge/passthrough/reencrypt TLS modes. Routes are OpenShift-specific; migrating to vanilla Kubernetes requires moving to Ingress or Gateway API.

```yaml
# OpenShift Route with edge TLS termination
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: api-route
  namespace: app-team-a
spec:
  host: api.apps.cluster.example.com
  path: /v1/
  to:
    kind: Service
    name: api-svc
    weight: 100
  port:
    targetPort: 8080
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
    certificate: |
      -----BEGIN CERTIFICATE-----
      MIIB... (certificate content)
      -----END CERTIFICATE-----
    key: |
      -----BEGIN PRIVATE KEY-----
      MIIB... (key content)
      -----END PRIVATE KEY-----
---
# Equivalent nginx Ingress (vanilla Kubernetes)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  namespace: app-team-a
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v1/
            pathType: Prefix
            backend:
              service:
                name: api-svc
                port:
                  number: 8080
```

## Operator Lifecycle Manager (OLM)

OLM manages the installation, upgrade, and dependency resolution of Kubernetes operators from **OperatorHub** catalogs. On vanilla Kubernetes, OLM can be installed independently; it ships pre-installed in OpenShift.

```yaml
# Install the Strimzi Kafka operator via OLM (OpenShift)
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: kafka-operatorgroup
  namespace: kafka
spec:
  targetNamespaces:
    - kafka
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: strimzi-kafka-operator
  namespace: kafka
spec:
  channel: stable
  name: strimzi-kafka-operator
  source: community-operators
  sourceNamespace: openshift-marketplace
  installPlanApproval: Automatic
  config:
    resources:
      limits:
        cpu: 1000m
        memory: 1Gi
      requests:
        cpu: 200m
        memory: 256Mi
```

```bash
# Check OLM install status
oc get subscription strimzi-kafka-operator -n kafka
oc get installplan -n kafka
oc get csv -n kafka
```

## OpenShift Virtualization

**OpenShift Virtualization** (based on KubeVirt) allows running virtual machines alongside containers in the same cluster. This converges VM and container workloads onto a single management plane.

```yaml
# Virtual Machine running RHEL 9
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: rhel9-vm
  namespace: virt-workloads
spec:
  running: true
  template:
    metadata:
      labels:
        kubevirt.io/vm: rhel9-vm
    spec:
      domain:
        cpu:
          cores: 4
          threads: 2
          sockets: 1
        memory:
          guest: 8Gi
        resources:
          requests:
            memory: 8Gi
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
            - name: cloudinit
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
        machine:
          type: q35
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          containerDisk:
            image: registry.redhat.io/rhel9/rhel-guest-image:latest
        - name: cloudinit
          cloudInitNoCloud:
            userDataBase64: |
              I2Nsb3VkLWNvbmZpZwp1c2VyczoKICAtIG5hbWU6IHJoZWwKICAgIHN1ZG86IEFMTAo=
```

```bash
# Connect to a VM console
virtctl console rhel9-vm -n virt-workloads

# Live-migrate a VM to a different node
virtctl migrate rhel9-vm -n virt-workloads

# Get VM status
oc get vm,vmi -n virt-workloads
```

## OpenShift Pipelines (Tekton)

OpenShift Pipelines ships Tekton pre-installed with an OpenShift-native UI and additional triggers integrations. The underlying objects are identical to upstream Tekton.

```bash
# Install the Pipelines operator (if not pre-installed)
oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: openshift-pipelines-operator
  namespace: openshift-operators
spec:
  channel: latest
  name: openshift-pipelines-operator-rh
  source: redhat-operators
  sourceNamespace: openshift-marketplace
EOF

# Verify installation
oc get tektonconfig
```

## OpenShift GitOps (ArgoCD)

OpenShift GitOps ships Red Hat's supported ArgoCD distribution with a pre-configured SSO integration using OpenShift OAuth.

```yaml
# Create an additional ArgoCD instance in a namespace
apiVersion: argoproj.io/v1alpha1
kind: ArgoCD
metadata:
  name: team-alpha-gitops
  namespace: team-alpha-gitops
spec:
  sso:
    provider: dex
    dex:
      openShiftOAuth: true
  rbac:
    defaultPolicy: role:readonly
    policy: |
      g, team-alpha-admins, role:admin
      g, cluster-admins, role:admin
    scopes: '[groups]'
  server:
    route:
      enabled: true
      tls:
        termination: reencrypt
  resourceExclusions: |
    - apiGroups:
        - tekton.dev
      clusters:
        - '*'
      kinds:
        - TaskRun
        - PipelineRun
```

## ROSA and ARO: Managed Offerings

**ROSA** (Red Hat OpenShift Service on AWS) and **ARO** (Azure Red Hat OpenShift) are fully managed OpenShift distributions operated jointly by Red Hat and the cloud provider. The cluster control plane is managed; customers are responsible for application deployments only.

### ROSA cluster creation

```bash
# Create ROSA cluster (HCP - Hosted Control Plane mode)
rosa create cluster \
  --cluster-name production-rosa \
  --sts \
  --mode auto \
  --region us-east-1 \
  --version 4.16 \
  --compute-machine-type m6i.2xlarge \
  --min-replicas 3 \
  --max-replicas 30 \
  --multi-az \
  --enable-autoscaling \
  --pod-cidr 10.128.0.0/14 \
  --service-cidr 172.30.0.0/16 \
  --hosted-cp

# Monitor cluster creation
rosa describe cluster --cluster production-rosa
rosa logs install --cluster production-rosa --watch

# Create an admin user
rosa create admin --cluster production-rosa
```

### ARO cluster creation

```bash
# Create ARO cluster
CLUSTER_NAME="production-aro"
RESOURCE_GROUP="rg-aro-production"
LOCATION="eastus"

# Create virtual network
az network vnet create \
  --resource-group "${RESOURCE_GROUP}" \
  --name vnet-aro \
  --address-prefixes 10.0.0.0/22

az network vnet subnet create \
  --resource-group "${RESOURCE_GROUP}" \
  --vnet-name vnet-aro \
  --name master-subnet \
  --address-prefixes 10.0.0.0/23 \
  --service-endpoints Microsoft.ContainerRegistry

az network vnet subnet create \
  --resource-group "${RESOURCE_GROUP}" \
  --vnet-name vnet-aro \
  --name worker-subnet \
  --address-prefixes 10.0.2.0/23 \
  --service-endpoints Microsoft.ContainerRegistry

# Create ARO cluster
az aro create \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CLUSTER_NAME}" \
  --vnet vnet-aro \
  --master-subnet master-subnet \
  --worker-subnet worker-subnet \
  --location "${LOCATION}" \
  --version 4.16.8 \
  --worker-count 5 \
  --worker-vm-size Standard_D8s_v3 \
  --pull-secret @pull-secret.txt

# Get credentials
az aro show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CLUSTER_NAME}" \
  --query "consoleProfile.url" -o tsv

az aro list-credentials \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${CLUSTER_NAME}"
```

## Migration from OpenShift to Vanilla Kubernetes

When OpenShift licensing costs or vendor lock-in become concerns, migration to vanilla Kubernetes requires addressing each OpenShift-specific construct.

### Migration checklist

```bash
#!/bin/bash
# Audit OpenShift-specific resources before migration
echo "=== Routes ==="
oc get routes --all-namespaces | wc -l

echo "=== BuildConfigs ==="
oc get buildconfigs --all-namespaces | wc -l

echo "=== ImageStreams ==="
oc get imagestreams --all-namespaces | wc -l

echo "=== SCCs bound to service accounts ==="
oc get clusterrolebindings \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.roleRef.name}{"\n"}{end}' \
  | grep scc | wc -l

echo "=== DeploymentConfigs (OCP-specific) ==="
oc get deploymentconfigs --all-namespaces | wc -l

echo "=== OLM Subscriptions ==="
oc get subscriptions --all-namespaces | wc -l
```

### Component mapping

| OpenShift Resource | Migration Target |
|---|---|
| `Route` | Ingress + cert-manager, or Gateway API |
| `BuildConfig` | Tekton Pipeline + Kaniko/Buildpacks |
| `ImageStream` | Kubernetes imagePullPolicy + Harbor/ECR |
| `DeploymentConfig` | `Deployment` (feature-equivalent) |
| `SCC` | Pod Security Standards + OPA Gatekeeper |
| `OperatorHub` / OLM | Helm + standalone OLM |
| `Project` | `Namespace` + ResourceQuota |
| `oauth-openshift` | Dex, Keycloak, or cloud IdP |
| `openshift-monitoring` | kube-prometheus-stack |
| `MCO / MachineConfig` | DaemonSet + Ansible / cloud-init |

### Converting DeploymentConfig to Deployment

```bash
#!/bin/bash
# Convert a DeploymentConfig to a Deployment
NAMESPACE="app-team-a"
DC_NAME="legacy-app"

# Export the DeploymentConfig
oc -n "${NAMESPACE}" get deploymentconfig "${DC_NAME}" -o json > /tmp/dc-export.json

# Transform to Deployment
cat /tmp/dc-export.json | jq '
  .apiVersion = "apps/v1"
  | .kind = "Deployment"
  | del(.metadata.resourceVersion, .metadata.uid, .metadata.selfLink,
        .metadata.creationTimestamp, .metadata.generation,
        .metadata.annotations["openshift.io/generated-by"],
        .status)
  | .spec = {
      "replicas": .spec.replicas,
      "selector": {"matchLabels": .spec.selector},
      "template": .spec.template,
      "strategy": {
        "type": "RollingUpdate",
        "rollingUpdate": {
          "maxSurge": "25%",
          "maxUnavailable": "25%"
        }
      }
    }
' > /tmp/deployment-export.yaml

echo "Generated: /tmp/deployment-export.yaml"
```

## Feature Gap Table

| Feature | OpenShift 4.x | Vanilla Kubernetes |
|---|---|---|
| Cluster self-upgrade | CVO (built-in) | Manual or Cluster API |
| Node OS management | MCO (built-in) | External tooling |
| Image builds | BuildConfig / S2I | Tekton + Kaniko (manual setup) |
| Internal registry | Built-in (HA optional) | Harbor, Quay (manual setup) |
| Developer portal | OpenShift Developer Console | Backstage (manual setup) |
| Operator marketplace | OperatorHub (curated) | Artifact Hub (community) |
| SCC/policy enforcement | SCCs (built-in) | PSS + Gatekeeper (manual setup) |
| VM workloads | OpenShift Virtualization | KubeVirt (manual setup) |
| Multi-cluster | ACM / RHACM | Admiralty, Liqo (manual setup) |
| Support | Red Hat enterprise | CNCF project support only |
| Compliance certifications | FIPS 140-2, DISA STIG | Depends on configuration |
| Cost | Subscription required | Open source (infra cost only) |

## When to Choose OpenShift

OpenShift is the right choice when:

1. **Regulatory compliance** requires FIPS-validated cryptography, CIS benchmarks, or DISA STIG profiles — OpenShift ships with these pre-configured.
2. **Windows workloads** need to run alongside Linux containers — OpenShift supports Windows worker nodes with the Windows Machine Config Operator.
3. **Virtual machines and containers** must coexist on the same platform — OpenShift Virtualization provides a mature KubeVirt implementation.
4. **Enterprise support SLAs** with a specific vendor are contractually required.
5. **Build and image management** need to be fully integrated — teams that cannot invest in a separate CI/CD pipeline benefit from BuildConfig and S2I.
6. **Multi-cluster management** at scale is needed — Red Hat ACM (Advanced Cluster Management) provides centralized policy, observability, and lifecycle management.

Vanilla Kubernetes is the right choice when:

1. **Cost sensitivity** is high — assembling an equivalent stack from CNCF projects is significantly cheaper at scale.
2. **Multi-cloud portability** is a priority — EKS, GKE, and AKS provide managed control planes without OpenShift's opinionated defaults.
3. **Engineering capability** is strong — teams comfortable with Helm, Kustomize, Tekton, and ArgoCD can build an equivalent platform.
4. **Rapid feature adoption** matters — upstream Kubernetes features land in managed distributions (EKS, GKE, AKS) faster than in OpenShift's slower release cadence.

## Compliance and Certifications

OpenShift ships with compliance profiles managed by the **Compliance Operator**, which scans nodes and cluster resources against industry benchmarks:

```bash
# Install the Compliance Operator (via OLM)
oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: compliance-operator
  namespace: openshift-compliance
spec:
  channel: release-0.1
  name: compliance-operator
  source: redhat-operators
  sourceNamespace: openshift-marketplace
EOF

# Run a CIS benchmark scan
oc apply -f - <<EOF
apiVersion: compliance.openshift.io/v1alpha1
kind: ScanSettingBinding
metadata:
  name: cis-compliance
  namespace: openshift-compliance
spec:
  profiles:
    - name: ocp4-cis
      kind: Profile
      apiGroup: compliance.openshift.io/v1alpha1
    - name: ocp4-cis-node
      kind: Profile
      apiGroup: compliance.openshift.io/v1alpha1
  settingsRef:
    name: default
    kind: ScanSetting
    apiGroup: compliance.openshift.io/v1alpha1
EOF

# Check scan results
oc get compliancecheckresults -n openshift-compliance \
  | grep FAIL | head -20

# Generate remediation objects
oc get complianceremediations -n openshift-compliance
```

The choice between OpenShift and vanilla Kubernetes ultimately depends on organizational maturity, budget, compliance requirements, and team capability. OpenShift provides an integrated, opinionated platform that reduces the operational burden of assembling and maintaining each component. Vanilla Kubernetes with a curated CNCF stack provides flexibility and cost efficiency at the expense of integration effort. Both paths lead to production-grade Kubernetes; the question is which trade-off fits the organization.
