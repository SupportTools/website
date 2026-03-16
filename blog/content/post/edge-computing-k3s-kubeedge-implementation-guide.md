---
title: "Edge Computing with K3s and KubeEdge: Enterprise Implementation Guide"
date: 2026-06-21T00:00:00-05:00
draft: false
tags: ["Edge Computing", "K3s", "KubeEdge", "Kubernetes", "IoT", "5G", "Edge Orchestration", "Distributed Systems"]
categories: ["Kubernetes", "Edge Computing", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing edge computing infrastructure with K3s and KubeEdge, including architecture patterns, deployment strategies, and production-ready configurations for enterprise edge workloads."
more_link: "yes"
url: "/edge-computing-k3s-kubeedge-implementation-guide/"
---

Edge computing brings computation and data storage closer to data sources, reducing latency and bandwidth usage. This comprehensive guide covers implementing enterprise-grade edge computing infrastructure using K3s and KubeEdge, including architecture design, deployment automation, and operational best practices.

<!--more-->

# Edge Computing with K3s and KubeEdge: Enterprise Implementation Guide

## Executive Summary

Edge computing is transforming how enterprises process data by moving computation closer to the source. K3s provides a lightweight Kubernetes distribution optimized for edge environments, while KubeEdge extends Kubernetes to edge devices with cloud-edge coordination. This guide provides practical implementation strategies for production edge deployments.

## Understanding Edge Computing Architecture

### Edge Computing Topology

**Multi-Tier Edge Architecture:**
```yaml
# edge-architecture.yaml
apiVersion: edge.kubernetes.io/v1
kind: EdgeArchitecture
metadata:
  name: enterprise-edge-topology
spec:
  tiers:
    - name: "Cloud Core"
      location: "Central Data Center"
      resources:
        compute: "unlimited"
        storage: "petabytes"
        network: "high-bandwidth"
      components:
        - name: "Master Kubernetes Cluster"
          type: "control-plane"
          replicas: 5
        - name: "Edge Controller"
          type: "kubeedge-cloudcore"
          replicas: 3
        - name: "Data Lake"
          type: "storage"
        - name: "ML Training Pipeline"
          type: "compute"

    - name: "Regional Edge"
      location: "Regional Data Centers"
      count: 10
      resources:
        compute: "100+ cores"
        storage: "100TB+"
        network: "medium-bandwidth"
      components:
        - name: "K3s Cluster"
          type: "edge-cluster"
          nodes: 10-50
        - name: "Edge Cache"
          type: "cache"
        - name: "Stream Processing"
          type: "compute"
        - name: "Local Storage"
          type: "storage"

    - name: "Local Edge"
      location: "Branch Offices / Stores"
      count: 100
      resources:
        compute: "8-16 cores"
        storage: "1-10TB"
        network: "low-bandwidth"
      components:
        - name: "K3s Node"
          type: "edge-node"
          nodes: 1-5
        - name: "Local Processing"
          type: "compute"
        - name: "Edge Storage"
          type: "storage"

    - name: "Far Edge / IoT"
      location: "Devices / Sensors"
      count: 10000+
      resources:
        compute: "embedded"
        storage: "GB scale"
        network: "intermittent"
      components:
        - name: "EdgeCore"
          type: "kubeedge-edgecore"
        - name: "Device Manager"
          type: "device-management"
        - name: "Local Cache"
          type: "storage"

  connectivity:
    cloudToRegional:
      protocol: "VPN/Direct Connect"
      bandwidth: "1-10 Gbps"
      latency: "10-50ms"

    regionalToLocal:
      protocol: "SD-WAN"
      bandwidth: "100Mbps-1Gbps"
      latency: "5-20ms"

    localToFarEdge:
      protocol: "WiFi/5G/LTE"
      bandwidth: "10-100Mbps"
      latency: "1-10ms"
      reliability: "intermittent"

  workloadPlacement:
    rules:
      - name: "Real-time Processing"
        placement: "Local Edge / Far Edge"
        latencyRequirement: "<10ms"

      - name: "Batch Analytics"
        placement: "Regional Edge"
        storageRequirement: "100GB+"

      - name: "ML Training"
        placement: "Cloud Core"
        computeRequirement: "GPU clusters"

      - name: "ML Inference"
        placement: "Local Edge"
        latencyRequirement: "<50ms"
```

### K3s vs KubeEdge Comparison

**Technology Selection Matrix:**
```go
// edge_comparison.go
package edge

import (
    "fmt"
)

// EdgeSolution represents an edge computing solution
type EdgeSolution struct {
    Name           string
    Type           string
    UseCases       []string
    Advantages     []string
    Limitations    []string
    ResourceReqs   ResourceRequirements
    NetworkReqs    NetworkRequirements
}

type ResourceRequirements struct {
    MinCPU        string
    MinRAM        string
    MinStorage    string
    Architecture  []string
}

type NetworkRequirements struct {
    Connectivity  string
    Bandwidth     string
    Latency       string
    Reliability   string
}

// GetK3sProfile returns K3s characteristics
func GetK3sProfile() EdgeSolution {
    return EdgeSolution{
        Name: "K3s",
        Type: "Lightweight Kubernetes Distribution",
        UseCases: []string{
            "Resource-constrained edge servers",
            "Branch office deployments",
            "CI/CD environments",
            "IoT gateways with good connectivity",
            "Multi-cluster edge deployments",
        },
        Advantages: []string{
            "Single binary < 100MB",
            "Low memory footprint (512MB minimum)",
            "Full Kubernetes compatibility",
            "Built-in SQLite (optional etcd)",
            "Automatic TLS certificate management",
            "Simple installation and upgrades",
            "Integrated load balancer (ServiceLB)",
            "Local storage provider",
        },
        Limitations: []string{
            "Requires continuous network connectivity",
            "No native device management",
            "Limited offline operation",
            "Standard Kubernetes resource overhead",
        },
        ResourceReqs: ResourceRequirements{
            MinCPU:       "1 core",
            MinRAM:       "512MB",
            MinStorage:   "1GB",
            Architecture: []string{"x86_64", "ARM64", "ARMv7"},
        },
        NetworkReqs: NetworkRequirements{
            Connectivity: "Continuous",
            Bandwidth:    "1+ Mbps",
            Latency:      "< 100ms to control plane",
            Reliability:  "High",
        },
    }
}

// GetKubeEdgeProfile returns KubeEdge characteristics
func GetKubeEdgeProfile() EdgeSolution {
    return EdgeSolution{
        Name: "KubeEdge",
        Type: "Cloud-Native Edge Computing Platform",
        UseCases: []string{
            "IoT device management",
            "Disconnected/intermittent connectivity",
            "Large-scale device deployments",
            "Edge AI/ML inference",
            "Industrial IoT applications",
            "5G edge computing (MEC)",
        },
        Advantages: []string{
            "Offline autonomy support",
            "Native device management (DMI)",
            "Edge-cloud message routing",
            "Lightweight edge components",
            "Device twin abstraction",
            "Edge data filtering",
            "Multiple messaging protocols (MQTT, HTTP)",
            "Optimized for unreliable networks",
        },
        Limitations: []string{
            "More complex architecture",
            "CloudCore dependency for cloud side",
            "Learning curve for device management",
            "Additional components to manage",
        },
        ResourceReqs: ResourceRequirements{
            MinCPU:       "0.5 cores (EdgeCore)",
            MinRAM:       "256MB (EdgeCore)",
            MinStorage:   "500MB",
            Architecture: []string{"x86_64", "ARM64", "ARMv7"},
        },
        NetworkReqs: NetworkRequirements{
            Connectivity: "Intermittent OK",
            Bandwidth:    "100+ Kbps",
            Latency:      "Variable (offline capable)",
            Reliability:  "Low to Medium OK",
        },
    }
}

// RecommendSolution recommends the best solution based on requirements
func RecommendSolution(req Requirements) EdgeSolution {
    if req.DeviceManagement && req.OfflineOperation {
        return GetKubeEdgeProfile()
    }

    if req.LargeScaleDevices && req.IntermittentConnectivity {
        return GetKubeEdgeProfile()
    }

    if req.StandardKubernetes && req.ReliableNetwork {
        return GetK3sProfile()
    }

    if req.SimpleDeployment && !req.DeviceManagement {
        return GetK3sProfile()
    }

    // Default to K3s for simpler use cases
    return GetK3sProfile()
}

type Requirements struct {
    DeviceManagement        bool
    OfflineOperation        bool
    LargeScaleDevices       bool
    IntermittentConnectivity bool
    StandardKubernetes      bool
    ReliableNetwork         bool
    SimpleDeployment        bool
}

// PrintComparison prints a detailed comparison
func PrintComparison() {
    k3s := GetK3sProfile()
    kubeedge := GetKubeEdgeProfile()

    fmt.Println("===== K3s vs KubeEdge Comparison =====\n")

    fmt.Println("K3s:")
    fmt.Printf("  Type: %s\n", k3s.Type)
    fmt.Println("  Best For:")
    for _, uc := range k3s.UseCases {
        fmt.Printf("    - %s\n", uc)
    }
    fmt.Println("  Key Advantages:")
    for _, adv := range k3s.Advantages {
        fmt.Printf("    + %s\n", adv)
    }
    fmt.Printf("  Min Resources: %s CPU, %s RAM, %s Storage\n",
        k3s.ResourceReqs.MinCPU,
        k3s.ResourceReqs.MinRAM,
        k3s.ResourceReqs.MinStorage)

    fmt.Println("\nKubeEdge:")
    fmt.Printf("  Type: %s\n", kubeedge.Type)
    fmt.Println("  Best For:")
    for _, uc := range kubeedge.UseCases {
        fmt.Printf("    - %s\n", uc)
    }
    fmt.Println("  Key Advantages:")
    for _, adv := range kubeedge.Advantages {
        fmt.Printf("    + %s\n", adv)
    }
    fmt.Printf("  Min Resources: %s CPU, %s RAM, %s Storage\n",
        kubeedge.ResourceReqs.MinCPU,
        kubeedge.ResourceReqs.MinRAM,
        kubeedge.ResourceReqs.MinStorage)
}

// GetHybridArchitecture suggests a hybrid deployment
func GetHybridArchitecture() string {
    return `
Hybrid K3s + KubeEdge Architecture:

1. Cloud Core (Data Center):
   - Standard Kubernetes cluster
   - KubeEdge CloudCore for device management
   - Centralized control and monitoring

2. Regional Edge (Well-Connected):
   - K3s clusters for standard workloads
   - Good network connectivity
   - Local data processing and caching

3. Far Edge (Constrained/Disconnected):
   - KubeEdge EdgeCore for device management
   - Offline autonomy
   - IoT device integration

This hybrid approach leverages the strengths of both:
- K3s for standard edge workloads with good connectivity
- KubeEdge for IoT devices and disconnected scenarios
`
}
```

## K3s Deployment and Configuration

### High-Availability K3s Cluster

**Production K3s Deployment:**
```bash
#!/bin/bash
# k3s-ha-deployment.sh
# Deploy production-grade K3s cluster with HA

set -euo pipefail

# Configuration
CLUSTER_NAME="edge-prod"
K3S_VERSION="v1.28.5+k3s1"
DATASTORE="postgres"  # or "etcd" for embedded, "mysql" for MySQL
DB_HOST="postgres.example.com"
DB_NAME="k3s"
DB_USER="k3s"
DB_PASS="secure-password"

# TLS configuration
TLS_SAN="edge-api.example.com"
CLUSTER_CIDR="10.42.0.0/16"
SERVICE_CIDR="10.43.0.0/16"

# High availability configuration
FIXED_REGISTRATION_ADDRESS="edge-api.example.com"

# Function to deploy first server node
deploy_first_server() {
    local node_ip=$1
    local node_name=$2

    echo "Deploying first K3s server node: ${node_name} (${node_ip})"

    curl -sfL https://get.k3s.io | \
        INSTALL_K3S_VERSION="${K3S_VERSION}" \
        INSTALL_K3S_EXEC="server" \
        sh -s - \
        --cluster-init \
        --datastore-endpoint="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:5432/${DB_NAME}" \
        --tls-san="${TLS_SAN}" \
        --tls-san="${node_ip}" \
        --node-name="${node_name}" \
        --cluster-cidr="${CLUSTER_CIDR}" \
        --service-cidr="${SERVICE_CIDR}" \
        --disable=traefik \
        --disable=servicelb \
        --write-kubeconfig-mode=644 \
        --kube-apiserver-arg="--anonymous-auth=false" \
        --kube-apiserver-arg="--audit-log-path=/var/log/kubernetes/audit.log" \
        --kube-apiserver-arg="--audit-log-maxage=30" \
        --kube-apiserver-arg="--audit-log-maxbackup=10" \
        --kube-apiserver-arg="--audit-log-maxsize=100"

    # Save token for joining additional nodes
    K3S_TOKEN=$(cat /var/lib/rancher/k3s/server/node-token)
    echo "${K3S_TOKEN}" > /tmp/k3s-token
    echo "K3s token saved to /tmp/k3s-token"
}

# Function to deploy additional server nodes
deploy_additional_server() {
    local node_ip=$1
    local node_name=$2
    local first_server=$3
    local token=$4

    echo "Deploying additional K3s server node: ${node_name} (${node_ip})"

    curl -sfL https://get.k3s.io | \
        INSTALL_K3S_VERSION="${K3S_VERSION}" \
        INSTALL_K3S_EXEC="server" \
        K3S_TOKEN="${token}" \
        sh -s - \
        --server="https://${first_server}:6443" \
        --datastore-endpoint="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:5432/${DB_NAME}" \
        --tls-san="${TLS_SAN}" \
        --tls-san="${node_ip}" \
        --node-name="${node_name}" \
        --disable=traefik \
        --disable=servicelb \
        --write-kubeconfig-mode=644
}

# Function to deploy agent (worker) nodes
deploy_agent() {
    local node_ip=$1
    local node_name=$2
    local server_url=$3
    local token=$4

    echo "Deploying K3s agent node: ${node_name} (${node_ip})"

    curl -sfL https://get.k3s.io | \
        INSTALL_K3S_VERSION="${K3S_VERSION}" \
        INSTALL_K3S_EXEC="agent" \
        K3S_TOKEN="${token}" \
        K3S_URL="https://${server_url}:6443" \
        sh -s - \
        --node-name="${node_name}" \
        --node-ip="${node_ip}"
}

# Function to configure MetalLB for bare metal load balancing
configure_metallb() {
    echo "Configuring MetalLB for load balancing..."

    # Install MetalLB
    kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.13.12/config/manifests/metallb-native.yaml

    # Wait for MetalLB to be ready
    kubectl wait --namespace metallb-system \
        --for=condition=ready pod \
        --selector=app=metallb \
        --timeout=90s

    # Configure IP address pool
    cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: edge-pool
  namespace: metallb-system
spec:
  addresses:
  - 192.168.1.240-192.168.1.250
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: edge-l2
  namespace: metallb-system
spec:
  ipAddressPools:
  - edge-pool
EOF

    echo "MetalLB configured successfully"
}

# Function to configure Longhorn for distributed storage
configure_longhorn() {
    echo "Configuring Longhorn distributed storage..."

    # Install Longhorn
    kubectl apply -f https://raw.githubusercontent.com/longhorn/longhorn/v1.5.3/deploy/longhorn.yaml

    # Wait for Longhorn to be ready
    kubectl wait --namespace longhorn-system \
        --for=condition=ready pod \
        --selector=app=longhorn-manager \
        --timeout=300s

    # Set Longhorn as default storage class
    kubectl patch storageclass longhorn \
        -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

    echo "Longhorn configured successfully"
}

# Function to install monitoring stack
install_monitoring() {
    echo "Installing monitoring stack..."

    # Create monitoring namespace
    kubectl create namespace monitoring || true

    # Install Prometheus operator
    helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
    helm repo update

    helm install prometheus prometheus-community/kube-prometheus-stack \
        --namespace monitoring \
        --set prometheus.prometheusSpec.retention=30d \
        --set prometheus.prometheusSpec.resources.requests.cpu=500m \
        --set prometheus.prometheusSpec.resources.requests.memory=2Gi \
        --set grafana.adminPassword=admin \
        --set grafana.persistence.enabled=true \
        --set grafana.persistence.size=10Gi

    echo "Monitoring stack installed successfully"
}

# Main deployment flow
main() {
    echo "Starting K3s HA deployment for ${CLUSTER_NAME}"

    # Example: Deploy to specific nodes
    # Adjust these based on your infrastructure

    # First server node
    # deploy_first_server "192.168.1.101" "k3s-server-1"

    # Additional server nodes (after first node is ready)
    # FIRST_SERVER="192.168.1.101"
    # K3S_TOKEN=$(cat /tmp/k3s-token)
    # deploy_additional_server "192.168.1.102" "k3s-server-2" "${FIRST_SERVER}" "${K3S_TOKEN}"
    # deploy_additional_server "192.168.1.103" "k3s-server-3" "${FIRST_SERVER}" "${K3S_TOKEN}"

    # Agent nodes
    # deploy_agent "192.168.1.104" "k3s-agent-1" "${FIXED_REGISTRATION_ADDRESS}" "${K3S_TOKEN}"
    # deploy_agent "192.168.1.105" "k3s-agent-2" "${FIXED_REGISTRATION_ADDRESS}" "${K3S_TOKEN}"

    echo "K3s cluster deployment initiated"
    echo "Run post-deployment configuration after cluster is ready"
}

# Post-deployment configuration
post_deployment() {
    echo "Running post-deployment configuration..."

    # Wait for cluster to be ready
    sleep 30

    # Configure MetalLB
    configure_metallb

    # Configure Longhorn
    configure_longhorn

    # Install monitoring
    install_monitoring

    echo "Post-deployment configuration complete"
}

# Script execution
if [[ "${1:-}" == "post" ]]; then
    post_deployment
else
    main
fi
```

**K3s Configuration File:**
```yaml
# /etc/rancher/k3s/config.yaml
# K3s server configuration

# Cluster configuration
cluster-cidr: "10.42.0.0/16"
service-cidr: "10.43.0.0/16"
cluster-dns: "10.43.0.10"
cluster-domain: "cluster.local"

# TLS configuration
tls-san:
  - "edge-api.example.com"
  - "192.168.1.100"
  - "192.168.1.101"
  - "192.168.1.102"

# Database configuration
datastore-endpoint: "postgres://k3s:password@postgres.example.com:5432/k3s"

# Disable embedded components
disable:
  - traefik
  - servicelb
  - local-storage
  - metrics-server

# Enable embedded components
# disable: []  # Enable all default components

# Node configuration
node-name: "k3s-server-1"
node-ip: "192.168.1.101"
node-external-ip: "203.0.113.10"

node-label:
  - "node-role.kubernetes.io/edge=true"
  - "topology.kubernetes.io/region=us-west"
  - "topology.kubernetes.io/zone=us-west-1a"

node-taint:
  - "node-role.kubernetes.io/master=true:NoSchedule"

# API server configuration
kube-apiserver-arg:
  - "anonymous-auth=false"
  - "audit-log-path=/var/log/kubernetes/audit.log"
  - "audit-log-maxage=30"
  - "audit-log-maxbackup=10"
  - "audit-log-maxsize=100"
  - "event-ttl=24h"
  - "service-account-lookup=true"

# Controller manager configuration
kube-controller-manager-arg:
  - "node-monitor-period=5s"
  - "node-monitor-grace-period=20s"
  - "pod-eviction-timeout=30s"

# Scheduler configuration
kube-scheduler-arg:
  - "v=2"

# Kubelet configuration
kubelet-arg:
  - "eviction-hard=memory.available<500Mi,nodefs.available<10%"
  - "eviction-soft=memory.available<1Gi,nodefs.available<15%"
  - "eviction-soft-grace-period=memory.available=1m30s,nodefs.available=2m"
  - "image-gc-high-threshold=80"
  - "image-gc-low-threshold=70"
  - "max-pods=110"

# Security configuration
secrets-encryption: true
protect-kernel-defaults: true

# Logging
debug: false
log: "/var/log/k3s.log"

# Networking
flannel-backend: "vxlan"  # or "wireguard" for encryption

# Write kubeconfig with appropriate permissions
write-kubeconfig-mode: "0644"
write-kubeconfig: "/etc/rancher/k3s/k3s.yaml"
```

### K3s Fleet Management

**Multi-Cluster Edge Management:**
```yaml
# fleet-configuration.yaml
apiVersion: fleet.cattle.io/v1alpha1
kind: GitRepo
metadata:
  name: edge-workloads
  namespace: fleet-default
spec:
  repo: "https://github.com/company/edge-workloads"
  branch: main
  paths:
    - /workloads
  targets:
    - name: "regional-edges"
      clusterSelector:
        matchLabels:
          env: production
          tier: regional
    - name: "local-edges"
      clusterSelector:
        matchLabels:
          env: production
          tier: local

---
apiVersion: fleet.cattle.io/v1alpha1
kind: ClusterGroup
metadata:
  name: regional-edge-group
  namespace: fleet-default
spec:
  selector:
    matchLabels:
      tier: regional
      env: production

---
apiVersion: fleet.cattle.io/v1alpha1
kind: ClusterGroup
metadata:
  name: local-edge-group
  namespace: fleet-default
spec:
  selector:
    matchLabels:
      tier: local
      env: production

---
# Workload definition with edge-specific configurations
apiVersion: fleet.cattle.io/v1alpha1
kind: Bundle
metadata:
  name: edge-application
  namespace: fleet-default
spec:
  resources:
    - content: |
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: edge-app
          namespace: default
        spec:
          replicas: 2
          selector:
            matchLabels:
              app: edge-app
          template:
            metadata:
              labels:
                app: edge-app
            spec:
              nodeSelector:
                node-role.kubernetes.io/edge: "true"
              tolerations:
                - key: "edge"
                  operator: "Equal"
                  value: "true"
                  effect: "NoSchedule"
              containers:
                - name: app
                  image: supporttools/edge-app:1.0
                  resources:
                    requests:
                      memory: "128Mi"
                      cpu: "100m"
                    limits:
                      memory: "256Mi"
                      cpu: "200m"
                  env:
                    - name: EDGE_LOCATION
                      valueFrom:
                        fieldRef:
                          fieldPath: spec.nodeName

  targets:
    - name: all-edges
      clusterGroup: regional-edge-group
    - name: local-edges
      clusterGroup: local-edge-group
      # Override for local edges with resource constraints
      helm:
        values:
          replicaCount: 1
          resources:
            limits:
              memory: "128Mi"
              cpu: "100m"
```

## KubeEdge Deployment and Configuration

### KubeEdge Cloud-Edge Architecture

**Complete KubeEdge Deployment:**
```bash
#!/bin/bash
# kubeedge-deployment.sh
# Deploy KubeEdge cloud and edge components

set -euo pipefail

# Configuration
KUBEEDGE_VERSION="v1.15.0"
CLOUD_CORE_IP="203.0.113.10"
CLOUD_CORE_PORT="10000"
ADVERTISE_ADDRESS="${CLOUD_CORE_IP}:${CLOUD_CORE_PORT}"

# Function to install CloudCore (runs in Kubernetes cluster)
install_cloudcore() {
    echo "Installing KubeEdge CloudCore..."

    # Download keadm
    wget -q https://github.com/kubeedge/kubeedge/releases/download/${KUBEEDGE_VERSION}/keadm-${KUBEEDGE_VERSION}-linux-amd64.tar.gz
    tar -xzf keadm-${KUBEEDGE_VERSION}-linux-amd64.tar.gz
    mv keadm-${KUBEEDGE_VERSION}-linux-amd64/keadm/keadm /usr/local/bin/
    chmod +x /usr/local/bin/keadm

    # Initialize CloudCore
    keadm init \
        --advertise-address="${ADVERTISE_ADDRESS}" \
        --kubeedge-version="${KUBEEDGE_VERSION}" \
        --kube-config=/root/.kube/config \
        --set cloudCore.modules.dynamicController.enable=true \
        --set cloudStream.enable=true

    echo "CloudCore installed successfully"

    # Get token for edge nodes
    keadm gettoken > /tmp/kubeedge-token.txt
    echo "Edge token saved to /tmp/kubeedge-token.txt"
}

# Function to install EdgeCore (runs on edge devices)
install_edgecore() {
    local edge_node_name=$1
    local token=$2

    echo "Installing KubeEdge EdgeCore on ${edge_node_name}..."

    # Download keadm
    wget -q https://github.com/kubeedge/kubeedge/releases/download/${KUBEEDGE_VERSION}/keadm-${KUBEEDGE_VERSION}-linux-amd64.tar.gz
    tar -xzf keadm-${KUBEEDGE_VERSION}-linux-amd64.tar.gz
    mv keadm-${KUBEEDGE_VERSION}-linux-amd64/keadm/keadm /usr/local/bin/
    chmod +x /usr/local/bin/keadm

    # Join edge node to cloud
    keadm join \
        --cloudcore-ipport="${ADVERTISE_ADDRESS}" \
        --edgenode-name="${edge_node_name}" \
        --token="${token}" \
        --kubeedge-version="${KUBEEDGE_VERSION}" \
        --with-mqtt=true \
        --runtimetype=docker

    echo "EdgeCore installed successfully on ${edge_node_name}"
}

# Function to configure device management
configure_device_management() {
    echo "Configuring device management..."

    # Create CRDs for device management
    kubectl apply -f https://raw.githubusercontent.com/kubeedge/kubeedge/release-1.15/build/crds/devices/devices_v1beta1_device.yaml
    kubectl apply -f https://raw.githubusercontent.com/kubeedge/kubeedge/release-1.15/build/crds/devices/devices_v1beta1_devicemodel.yaml

    # Enable device controller in CloudCore
    kubectl edit -n kubeedge configmap cloudcore
    # Set: modules.dynamicController.enable: true

    echo "Device management configured"
}

# Function to deploy MQTT broker for device communication
deploy_mqtt_broker() {
    echo "Deploying MQTT broker..."

    cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mosquitto
  namespace: kubeedge
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mosquitto
  template:
    metadata:
      labels:
        app: mosquitto
    spec:
      containers:
      - name: mosquitto
        image: eclipse-mosquitto:2.0
        ports:
        - containerPort: 1883
          name: mqtt
        - containerPort: 9001
          name: websocket
        volumeMounts:
        - name: config
          mountPath: /mosquitto/config
        - name: data
          mountPath: /mosquitto/data
        - name: log
          mountPath: /mosquitto/log
      volumes:
      - name: config
        configMap:
          name: mosquitto-config
      - name: data
        emptyDir: {}
      - name: log
        emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: mosquitto
  namespace: kubeedge
spec:
  selector:
    app: mosquitto
  ports:
  - name: mqtt
    port: 1883
    targetPort: 1883
  - name: websocket
    port: 9001
    targetPort: 9001
  type: LoadBalancer
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: mosquitto-config
  namespace: kubeedge
data:
  mosquitto.conf: |
    listener 1883
    protocol mqtt

    listener 9001
    protocol websockets

    allow_anonymous true
    persistence true
    persistence_location /mosquitto/data/

    log_dest file /mosquitto/log/mosquitto.log
    log_dest stdout
EOF

    echo "MQTT broker deployed"
}

# Main installation flow
main() {
    echo "Starting KubeEdge deployment"

    # Install CloudCore (run on master cluster)
    # install_cloudcore

    # Save token
    # TOKEN=$(cat /tmp/kubeedge-token.txt)

    # Install EdgeCore (run on each edge device)
    # install_edgecore "edge-device-1" "${TOKEN}"
    # install_edgecore "edge-device-2" "${TOKEN}"

    # Configure device management
    # configure_device_management

    # Deploy MQTT broker
    # deploy_mqtt_broker

    echo "KubeEdge deployment complete"
}

main
```

**KubeEdge Configuration:**
```yaml
# cloudcore-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cloudcore
  namespace: kubeedge
data:
  cloudcore.yaml: |
    apiVersion: cloudcore.config.kubeedge.io/v1alpha1
    kind: CloudCore
    kubeAPIConfig:
      kubeConfig: /root/.kube/config
      master: ""
      qps: 100
      burst: 200
      contentType: application/vnd.kubernetes.protobuf
    modules:
      cloudHub:
        enable: true
        nodeLimit: 1000
        tlsCAFile: /etc/kubeedge/ca/rootCA.crt
        tlsCertFile: /etc/kubeedge/certs/server.crt
        tlsPrivateKeyFile: /etc/kubeedge/certs/server.key
        unixsocket:
          address: unix:///var/lib/kubeedge/kubeedge.sock
          enable: true
        websocket:
          address: 0.0.0.0
          enable: true
          port: 10000
        quic:
          address: 0.0.0.0
          enable: false
          maxIncomingStreams: 10000
          port: 10001
        https:
          address: 0.0.0.0
          enable: true
          port: 10002

      edgeController:
        enable: true
        buffer:
          podEvent: 1024
          configMapEvent: 1024
          secretEvent: 1024
          rulesEvent: 1024
          endpointsEvent: 1024
        load:
          updatePodStatusWorkers: 1
          updateNodeStatusWorkers: 1
          queryConfigMapWorkers: 4
          querySecretWorkers: 4
          queryServiceWorkers: 4
          queryEndpointsWorkers: 4

      deviceController:
        enable: true
        buffer:
          deviceEvent: 1024
          deviceModelEvent: 1024

      dynamicController:
        enable: true

      cloudStream:
        enable: true
        tlsTunnelCAFile: /etc/kubeedge/ca/rootCA.crt
        tlsTunnelCertFile: /etc/kubeedge/certs/server.crt
        tlsTunnelPrivateKeyFile: /etc/kubeedge/certs/server.key
        streamPort: 10003
        tunnelPort: 10004

---
# edgecore-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: edgecore-config
data:
  edgecore.yaml: |
    apiVersion: edgecore.config.kubeedge.io/v1alpha2
    kind: EdgeCore
    modules:
      edged:
        enable: true
        cgroupDriver: systemd
        clusterDNS: 169.254.96.16
        clusterDomain: cluster.local
        devicePluginEnabled: true
        gpuPluginEnabled: false
        imageGCHighThreshold: 80
        imageGCLowThreshold: 40
        maximumDeadContainersPerPod: 1
        networkPluginName: cni
        podSandboxImage: k8s.gcr.io/pause:3.6
        registerNode: true
        registerNodeNamespace: default
        remoteImageEndpoint: unix:///var/run/dockershim.sock
        remoteRuntimeEndpoint: unix:///var/run/dockershim.sock
        runtimeType: docker

      edgeHub:
        enable: true
        heartbeat: 15
        tlsCaFile: /etc/kubeedge/ca/rootCA.crt
        tlsCertFile: /etc/kubeedge/certs/server.crt
        tlsPrivateKeyFile: /etc/kubeedge/certs/server.key
        httpServer: https://203.0.113.10:10002
        websocket:
          enable: true
          handshakeTimeout: 30
          server: 203.0.113.10:10000
        quic:
          enable: false
          handshakeTimeout: 30
          server: 203.0.113.10:10001

      eventBus:
        enable: true
        mqttMode: 2  # 0: internal, 1: both, 2: external
        mqttServerExternal: tcp://mosquitto.kubeedge.svc:1883
        mqttServerInternal: tcp://127.0.0.1:1884
        mqttSubClientID: edge-sub
        mqttPubClientID: edge-pub

      metaManager:
        enable: true
        metaServer:
          enable: true
          server: 127.0.0.1:10550
          tlsCaFile: /etc/kubeedge/ca/rootCA.crt
          tlsCertFile: /etc/kubeedge/certs/server.crt
          tlsPrivateKeyFile: /etc/kubeedge/certs/server.key

      servicebus:
        enable: false

      deviceTwin:
        enable: true

      dbTest:
        enable: false

      edgeStream:
        enable: true
        handshakeTimeout: 30
        readDeadline: 15
        server: 203.0.113.10:10004
        tlsTunnelCAFile: /etc/kubeedge/ca/rootCA.crt
        tlsTunnelCertFile: /etc/kubeedge/certs/server.crt
        tlsTunnelPrivateKeyFile: /etc/kubeedge/certs/server.key
        writeDeadline: 15
```

### Device Management with KubeEdge

**IoT Device Integration:**
```yaml
# device-model.yaml
apiVersion: devices.kubeedge.io/v1beta1
kind: DeviceModel
metadata:
  name: temperature-sensor-model
  namespace: default
spec:
  properties:
    - name: temperature
      description: "Current temperature reading"
      type:
        float:
          accessMode: ReadOnly
          defaultValue: 0.0
          minimum: -50.0
          maximum: 150.0
          unit: "Celsius"

    - name: humidity
      description: "Current humidity reading"
      type:
        int:
          accessMode: ReadOnly
          defaultValue: 0
          minimum: 0
          maximum: 100
          unit: "Percent"

    - name: status
      description: "Device operational status"
      type:
        string:
          accessMode: ReadWrite
          defaultValue: "online"

    - name: sampling_rate
      description: "Data sampling rate in seconds"
      type:
        int:
          accessMode: ReadWrite
          defaultValue: 60
          minimum: 1
          maximum: 3600
          unit: "Seconds"

  protocol:
    modbus:
      slaveID: 1
    opcua:
      url: "opc.tcp://192.168.1.10:4840"
    bluetooth:
      macAddress: "AA:BB:CC:DD:EE:FF"
    customizedProtocol:
      protocolName: "custom-mqtt"
      configData:
        topic: "sensors/temperature"
        qos: 1

---
# device-instance.yaml
apiVersion: devices.kubeedge.io/v1beta1
kind: Device
metadata:
  name: temp-sensor-warehouse-01
  namespace: default
  labels:
    location: warehouse-01
    type: temperature-sensor
    criticality: high
spec:
  deviceModelRef:
    name: temperature-sensor-model

  nodeSelector:
    nodeSelectorTerms:
      - matchExpressions:
          - key: kubernetes.io/hostname
            operator: In
            values:
              - edge-node-warehouse-01

  protocol:
    modbus:
      slaveID: 1
      tcp:
        ip: "192.168.10.20"
        port: 502
    # Alternative protocols
    # opcua:
    #   url: "opc.tcp://192.168.10.20:4840"
    #   userName: "admin"
    #   password: "password"
    #   securityPolicy: "None"
    #   securityMode: "None"
    # customizedProtocol:
    #   protocolName: "mqtt"
    #   configData:
    #     brokerURL: "tcp://mqtt-broker:1883"
    #     topic: "warehouse-01/temp-sensor"
    #     clientID: "temp-sensor-01"

  propertyVisitors:
    - propertyName: temperature
      modbus:
        register: "CoilRegister"
        offset: 2
        limit: 1
        scale: 0.1
        isSwap: false
        isRegisterSwap: false

    - propertyName: humidity
      modbus:
        register: "CoilRegister"
        offset: 3
        limit: 1
        scale: 1
        isSwap: false
        isRegisterSwap: false

    - propertyName: status
      modbus:
        register: "HoldingRegister"
        offset: 0
        limit: 1

    - propertyName: sampling_rate
      modbus:
        register: "HoldingRegister"
        offset: 1
        limit: 1

  data:
    dataTopic: "$ke/events/device/temp-sensor-warehouse-01/data/update"
    dataProperties:
      - propertyName: temperature
        metadata:
          type: "float"
          unit: "Celsius"
      - propertyName: humidity
        metadata:
          type: "int"
          unit: "Percent"

status:
  twins:
    - propertyName: temperature
      reported:
        value: "25.5"
        metadata:
          timestamp: "1638360000000"
          type: "float"
    - propertyName: humidity
      reported:
        value: "60"
        metadata:
          timestamp: "1638360000000"
          type: "int"

---
# device-twin-application.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: device-data-processor
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: device-data-processor
  template:
    metadata:
      labels:
        app: device-data-processor
    spec:
      nodeSelector:
        node-role.kubernetes.io/edge: "true"
      containers:
        - name: processor
          image: supporttools/device-data-processor:1.0
          env:
            - name: MQTT_BROKER
              value: "tcp://mosquitto.kubeedge.svc:1883"
            - name: DATA_TOPIC
              value: "$ke/events/device/+/data/update"
            - name: INFLUXDB_URL
              value: "http://influxdb.monitoring.svc:8086"
          volumeMounts:
            - name: device-config
              mountPath: /etc/device-config
      volumes:
        - name: device-config
          configMap:
            name: device-processor-config

---
# device-processor-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: device-processor-config
  namespace: default
data:
  config.yaml: |
    processors:
      - name: "temperature-alert"
        condition: "temperature > 30"
        action: "send-alert"
        destination: "alerts-webhook"

      - name: "data-aggregation"
        interval: "5m"
        action: "aggregate"
        functions:
          - "average"
          - "min"
          - "max"

      - name: "data-storage"
        action: "store"
        destination: "influxdb"
        retention: "30d"
```

## Edge Workload Patterns

### Edge-Optimized Application Deployment

**Intelligent Workload Placement:**
```yaml
# edge-workload-placement.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: edge-apps

---
# Priority-based scheduling for edge workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: edge-critical
value: 1000000
globalDefault: false
description: "Critical edge workloads that must run"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: edge-high
value: 100000
globalDefault: false
description: "High priority edge workloads"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: edge-normal
value: 10000
globalDefault: true
description: "Normal edge workloads"

---
# Real-time video analytics at edge
apiVersion: apps/v1
kind: Deployment
metadata:
  name: video-analytics
  namespace: edge-apps
spec:
  replicas: 1
  selector:
    matchLabels:
      app: video-analytics
  template:
    metadata:
      labels:
        app: video-analytics
        workload-type: realtime
    spec:
      priorityClassName: edge-critical

      # Node selection for edge placement
      nodeSelector:
        node-role.kubernetes.io/edge: "true"
        hardware.edge/gpu: "true"
        location.edge/zone: "retail-01"

      # Affinity rules
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: workload.edge/video-analytics
                    operator: In
                    values:
                      - "true"
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: hardware.edge/inference-accelerator
                    operator: In
                    values:
                      - "nvidia"
                      - "intel-movidius"

        # Anti-affinity to avoid co-location
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: workload-type
                      operator: In
                      values:
                        - realtime
                topologyKey: kubernetes.io/hostname

      # Tolerations for edge node taints
      tolerations:
        - key: "edge"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"
        - key: "node-role.kubernetes.io/edge"
          operator: "Exists"
          effect: "NoSchedule"

      containers:
        - name: analytics
          image: supporttools/video-analytics:1.0
          resources:
            requests:
              memory: "2Gi"
              cpu: "2000m"
              nvidia.com/gpu: "1"
            limits:
              memory: "4Gi"
              cpu: "4000m"
              nvidia.com/gpu: "1"

          env:
            - name: INFERENCE_MODEL
              value: "yolov5-nano"
            - name: CONFIDENCE_THRESHOLD
              value: "0.7"
            - name: EDGE_LOCATION
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: MQTT_BROKER
              value: "tcp://edge-mqtt:1883"

          volumeMounts:
            - name: video-stream
              mountPath: /video
            - name: models
              mountPath: /models
            - name: tmp
              mountPath: /tmp

      volumes:
        - name: video-stream
          hostPath:
            path: /dev/video0
            type: CharDevice
        - name: models
          persistentVolumeClaim:
            claimName: ml-models-pvc
        - name: tmp
          emptyDir:
            sizeLimit: 10Gi

---
# Edge caching layer
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: edge-cache
  namespace: edge-apps
spec:
  selector:
    matchLabels:
      app: edge-cache
  template:
    metadata:
      labels:
        app: edge-cache
    spec:
      nodeSelector:
        node-role.kubernetes.io/edge: "true"

      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet

      containers:
        - name: cache
          image: redis:7-alpine
          ports:
            - containerPort: 6379
              hostPort: 6379
              protocol: TCP
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"

          volumeMounts:
            - name: cache-data
              mountPath: /data
            - name: config
              mountPath: /usr/local/etc/redis

          livenessProbe:
            tcpSocket:
              port: 6379
            initialDelaySeconds: 30
            periodSeconds: 10

          readinessProbe:
            exec:
              command:
                - redis-cli
                - ping
            initialDelaySeconds: 5
            periodSeconds: 5

      volumes:
        - name: cache-data
          hostPath:
            path: /var/lib/edge-cache
            type: DirectoryOrCreate
        - name: config
          configMap:
            name: redis-config

---
# Edge ML inference service
apiVersion: v1
kind: Service
metadata:
  name: ml-inference
  namespace: edge-apps
spec:
  type: ClusterIP
  selector:
    app: ml-inference
  ports:
    - port: 8080
      targetPort: 8080
      protocol: TCP

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ml-inference
  namespace: edge-apps
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ml-inference
  template:
    metadata:
      labels:
        app: ml-inference
        workload-type: ml-inference
    spec:
      priorityClassName: edge-high

      nodeSelector:
        node-role.kubernetes.io/edge: "true"

      containers:
        - name: inference
          image: supporttools/tflite-inference:1.0
          ports:
            - containerPort: 8080
              protocol: TCP

          resources:
            requests:
              memory: "512Mi"
              cpu: "500m"
            limits:
              memory: "1Gi"
              cpu: "1000m"

          env:
            - name: MODEL_PATH
              value: "/models/model.tflite"
            - name: BATCH_SIZE
              value: "1"
            - name: NUM_THREADS
              value: "4"

          volumeMounts:
            - name: models
              mountPath: /models
              readOnly: true

          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10

          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5

      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: ml-models-pvc
```

## Performance Optimization and Monitoring

### Edge-Specific Monitoring Stack

**Lightweight Monitoring for Edge:**
```yaml
# edge-monitoring.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: edge-monitoring

---
# Prometheus for edge metrics
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-edge-config
  namespace: edge-monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 30s
      evaluation_interval: 30s
      external_labels:
        cluster: 'edge-cluster'
        region: 'us-west'

    scrape_configs:
      - job_name: 'kubernetes-nodes'
        kubernetes_sd_configs:
          - role: node
        relabel_configs:
          - source_labels: [__address__]
            regex: '(.*):10250'
            replacement: '${1}:9100'
            target_label: __address__
            action: replace

      - job_name: 'kubernetes-pods'
        kubernetes_sd_configs:
          - role: pod
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
            action: keep
            regex: true
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
            action: replace
            target_label: __metrics_path__
            regex: (.+)

      - job_name: 'edge-devices'
        static_configs:
          - targets:
              - 'device-exporter:9101'

    remote_write:
      - url: https://prometheus.central.example.com/api/v1/write
        queue_config:
          capacity: 10000
          max_shards: 5
          min_shards: 1
          max_samples_per_send: 1000
          batch_send_deadline: 5s
          min_backoff: 30ms
          max_backoff: 100ms

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: edge-monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      nodeSelector:
        node-role.kubernetes.io/edge: "true"

      containers:
        - name: prometheus
          image: prom/prometheus:v2.48.0
          args:
            - '--config.file=/etc/prometheus/prometheus.yml'
            - '--storage.tsdb.path=/prometheus'
            - '--storage.tsdb.retention.time=7d'
            - '--storage.tsdb.retention.size=10GB'
            - '--web.enable-lifecycle'
            - '--web.enable-admin-api'

          ports:
            - containerPort: 9090
              name: http

          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"

          volumeMounts:
            - name: config
              mountPath: /etc/prometheus
            - name: storage
              mountPath: /prometheus

      volumes:
        - name: config
          configMap:
            name: prometheus-edge-config
        - name: storage
          persistentVolumeClaim:
            claimName: prometheus-storage

---
# Edge-optimized Grafana
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: edge-monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      containers:
        - name: grafana
          image: grafana/grafana:10.2.2
          env:
            - name: GF_SECURITY_ADMIN_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: grafana-credentials
                  key: admin-password
            - name: GF_INSTALL_PLUGINS
              value: "grafana-piechart-panel"

          ports:
            - containerPort: 3000
              name: http

          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "256Mi"
              cpu: "200m"

          volumeMounts:
            - name: storage
              mountPath: /var/lib/grafana
            - name: datasources
              mountPath: /etc/grafana/provisioning/datasources
            - name: dashboards-config
              mountPath: /etc/grafana/provisioning/dashboards
            - name: dashboards
              mountPath: /var/lib/grafana/dashboards

      volumes:
        - name: storage
          persistentVolumeClaim:
            claimName: grafana-storage
        - name: datasources
          configMap:
            name: grafana-datasources
        - name: dashboards-config
          configMap:
            name: grafana-dashboards-config
        - name: dashboards
          configMap:
            name: grafana-dashboards
```

## Conclusion

Edge computing with K3s and KubeEdge enables enterprises to:

1. **Reduce Latency**: Process data closer to the source for real-time applications
2. **Optimize Bandwidth**: Minimize data transfer to cloud by processing at edge
3. **Improve Resilience**: Maintain operations during network disruptions
4. **Scale Efficiently**: Deploy thousands of edge locations with centralized management
5. **Enable IoT Integration**: Seamlessly manage devices with KubeEdge device twins
6. **Cost Optimization**: Reduce cloud costs by processing and filtering data at edge

By combining K3s for standard edge workloads and KubeEdge for IoT device management, organizations can build robust, scalable edge computing infrastructure that meets diverse enterprise requirements.

For more information on edge computing and Kubernetes, visit [support.tools](https://support.tools).