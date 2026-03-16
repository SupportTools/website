---
title: "Building Private Cloud Infrastructure with OpenStack and Kubernetes: Enterprise Guide"
date: 2026-10-27T00:00:00-05:00
draft: false
tags: ["OpenStack", "Kubernetes", "Private Cloud", "Cloud Infrastructure", "Virtualization", "Container Orchestration", "OpenStack-Helm"]
categories: ["Cloud Infrastructure", "Kubernetes", "Virtualization"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to building enterprise-grade private cloud infrastructure combining OpenStack for infrastructure as a service with Kubernetes for container orchestration, including deployment, integration, and management strategies."
more_link: "yes"
url: "/private-cloud-openstack-kubernetes-enterprise-guide/"
---

Building a private cloud infrastructure that combines OpenStack's Infrastructure as a Service (IaaS) capabilities with Kubernetes' container orchestration creates a powerful, flexible platform for enterprise workloads. This comprehensive guide covers the architecture, deployment, and operational strategies for running production-grade private clouds using OpenStack and Kubernetes together.

<!--more-->

## Architecture Overview

### Understanding the Stack

The integration of OpenStack and Kubernetes creates a layered architecture that provides both virtual machine and container-based workloads:

```text
┌─────────────────────────────────────────────┐
│         Application Workloads                │
├─────────────────────────────────────────────┤
│    Kubernetes Container Platform             │
│    ├── Pods, Services, Ingress              │
│    ├── Storage (Cinder CSI)                 │
│    └── Network (Neutron CNI)                │
├─────────────────────────────────────────────┤
│    OpenStack Infrastructure Services         │
│    ├── Nova (Compute)                       │
│    ├── Neutron (Networking)                 │
│    ├── Cinder (Block Storage)               │
│    ├── Swift (Object Storage)               │
│    ├── Keystone (Identity)                  │
│    └── Glance (Image Service)               │
├─────────────────────────────────────────────┤
│    Undercloud Infrastructure                 │
│    ├── Bare Metal Servers                   │
│    ├── Storage Systems (Ceph)               │
│    └── Network Infrastructure                │
└─────────────────────────────────────────────┘
```

### Deployment Patterns

**Pattern 1: Kubernetes on OpenStack**
- OpenStack provides IaaS layer
- Kubernetes VMs deployed on OpenStack Nova
- Cinder for persistent storage
- Neutron for networking

**Pattern 2: OpenStack on Kubernetes (OpenStack-Helm)**
- Kubernetes as base platform
- OpenStack services running as containers
- Unified management platform
- Cloud-native deployment model

**Pattern 3: Hybrid Approach**
- OpenStack for traditional VM workloads
- Dedicated bare-metal Kubernetes for containers
- Shared storage and networking infrastructure
- Workload-optimized resource allocation

## OpenStack Deployment with Kolla-Ansible

### Infrastructure Preparation

#### Hardware Requirements

```yaml
# inventory/hosts.ini
[control]
os-controller01 ansible_host=10.0.1.11 ansible_user=ubuntu
os-controller02 ansible_host=10.0.1.12 ansible_user=ubuntu
os-controller03 ansible_host=10.0.1.13 ansible_user=ubuntu

[network]
os-network01 ansible_host=10.0.1.21 ansible_user=ubuntu
os-network02 ansible_host=10.0.1.22 ansible_user=ubuntu

[compute]
os-compute[01:10] ansible_host=10.0.2.[11:20] ansible_user=ubuntu

[storage]
os-storage[01:05] ansible_host=10.0.3.[11:15] ansible_user=ubuntu

[monitoring]
os-monitoring01 ansible_host=10.0.1.31 ansible_user=ubuntu

# Groups
[all:vars]
ansible_python_interpreter=/usr/bin/python3
```

#### System Preparation Playbook

```yaml
# playbooks/prepare-hosts.yml
---
- name: Prepare OpenStack hosts
  hosts: all
  become: true
  tasks:
    - name: Update system packages
      apt:
        update_cache: yes
        upgrade: dist
        cache_valid_time: 3600

    - name: Install required packages
      apt:
        name:
          - python3-pip
          - python3-dev
          - libffi-dev
          - gcc
          - libssl-dev
          - git
          - curl
          - vim
          - net-tools
          - ntp
        state: present

    - name: Configure NTP
      copy:
        content: |
          pool 0.pool.ntp.org iburst
          pool 1.pool.ntp.org iburst
          pool 2.pool.ntp.org iburst
        dest: /etc/ntp.conf
      notify: restart ntp

    - name: Enable and start NTP
      systemd:
        name: ntp
        enabled: yes
        state: started

    - name: Configure kernel parameters
      sysctl:
        name: "{{ item.name }}"
        value: "{{ item.value }}"
        state: present
        reload: yes
      loop:
        - { name: 'net.ipv4.ip_forward', value: '1' }
        - { name: 'net.ipv4.conf.all.rp_filter', value: '0' }
        - { name: 'net.ipv4.conf.default.rp_filter', value: '0' }
        - { name: 'net.bridge.bridge-nf-call-iptables', value: '1' }
        - { name: 'net.bridge.bridge-nf-call-ip6tables', value: '1' }

    - name: Load kernel modules
      modprobe:
        name: "{{ item }}"
        state: present
      loop:
        - br_netfilter
        - overlay
        - ip_vs
        - ip_vs_rr
        - ip_vs_wrr
        - ip_vs_sh

    - name: Ensure kernel modules load on boot
      copy:
        content: |
          br_netfilter
          overlay
          ip_vs
          ip_vs_rr
          ip_vs_wrr
          ip_vs_sh
        dest: /etc/modules-load.d/openstack.conf

    - name: Configure Docker registry for Kolla
      copy:
        content: |
          {
            "insecure-registries": ["10.0.1.11:4000"],
            "live-restore": true,
            "log-driver": "json-file",
            "log-opts": {
              "max-size": "100m",
              "max-file": "3"
            }
          }
        dest: /etc/docker/daemon.json
      notify: restart docker

  handlers:
    - name: restart ntp
      systemd:
        name: ntp
        state: restarted

    - name: restart docker
      systemd:
        name: docker
        state: restarted
```

### Kolla-Ansible Configuration

#### Global Configuration

```yaml
# /etc/kolla/globals.yml
---
kolla_base_distro: "ubuntu"
kolla_install_type: "source"
openstack_release: "zed"

# Network configuration
network_interface: "eth0"
neutron_external_interface: "eth1"
kolla_internal_vip_address: "10.0.1.10"
kolla_external_vip_address: "192.168.100.10"

# Enable services
enable_haproxy: "yes"
enable_mariadb: "yes"
enable_memcached: "yes"
enable_rabbitmq: "yes"

# Core OpenStack services
enable_keystone: "yes"
enable_glance: "yes"
enable_nova: "yes"
enable_neutron: "yes"
enable_cinder: "yes"
enable_horizon: "yes"

# Optional services
enable_heat: "yes"
enable_magnum: "yes"
enable_octavia: "yes"
enable_designate: "yes"
enable_barbican: "yes"

# Storage backends
enable_ceph: "yes"
enable_ceph_rgw: "yes"
glance_backend_ceph: "yes"
cinder_backend_ceph: "yes"
nova_backend_ceph: "yes"

# Neutron configuration
neutron_plugin_agent: "openvswitch"
neutron_type_drivers: "flat,vlan,vxlan"
neutron_tenant_network_types: "vxlan"

# Nova configuration
nova_compute_virt_type: "kvm"
nova_console: "novnc"

# Ceph configuration
ceph_pool_pg_num: 128
ceph_pool_pgp_num: 128

# Monitoring
enable_prometheus: "yes"
enable_grafana: "yes"
enable_elasticsearch: "yes"
enable_kibana: "yes"

# TLS Configuration
kolla_enable_tls_external: "yes"
kolla_enable_tls_internal: "yes"
kolla_certificates_dir: "/etc/kolla/certificates"

# Additional options
openstack_logging_debug: "False"
enable_central_logging: "yes"
```

#### Service-Specific Configuration

```yaml
# /etc/kolla/config/nova.conf
[DEFAULT]
cpu_allocation_ratio = 4.0
ram_allocation_ratio = 1.5
disk_allocation_ratio = 1.5
reserved_host_memory_mb = 4096

[libvirt]
virt_type = kvm
cpu_mode = host-passthrough
cpu_model_extra_flags = pcid

[compute]
consecutive_build_service_disable_threshold = 5

[neutron]
service_metadata_proxy = true
metadata_proxy_shared_secret = <SECRET>

# /etc/kolla/config/neutron.conf
[DEFAULT]
global_physnet_mtu = 9000
l3_ha = true
max_l3_agents_per_router = 3
min_l3_agents_per_router = 2
dhcp_agents_per_network = 2

[ml2]
path_mtu = 9000
physical_network_mtus = physnet1:9000

[ovs]
bridge_mappings = physnet1:br-ex
local_ip = {{ tunnel_interface_address }}

# /etc/kolla/config/cinder.conf
[DEFAULT]
backup_driver = cinder.backup.drivers.ceph
backup_ceph_pool = backups
backup_ceph_user = cinder-backup

[ceph]
rbd_flatten_volume_from_snapshot = true
rbd_max_clone_depth = 5
```

### Deploying OpenStack

```bash
#!/bin/bash
# deploy-openstack.sh

set -euo pipefail

# Install dependencies
sudo apt-get update
sudo apt-get install -y python3-dev libffi-dev gcc libssl-dev python3-pip

# Install Kolla-Ansible
pip3 install 'kolla-ansible==15.0.0'

# Create configuration directory
sudo mkdir -p /etc/kolla
sudo chown $USER:$USER /etc/kolla

# Copy configuration files
cp -r /usr/local/share/kolla-ansible/etc_examples/kolla/* /etc/kolla/
cp /usr/local/share/kolla-ansible/ansible/inventory/* .

# Generate passwords
kolla-genpwd

# Bootstrap servers
kolla-ansible -i multinode bootstrap-servers

# Perform prechecks
kolla-ansible -i multinode prechecks

# Deploy OpenStack
kolla-ansible -i multinode deploy

# Post-deployment configuration
kolla-ansible -i multinode post-deploy

# Install OpenStack CLI
pip3 install python-openstackclient python-neutronclient python-cinderclient

# Source admin credentials
source /etc/kolla/admin-openrc.sh

# Initialize cloud
./init-runonce

echo "OpenStack deployment completed successfully"
echo "Dashboard URL: https://$(hostname -f)"
echo "Admin credentials: /etc/kolla/admin-openrc.sh"
```

## Kubernetes Deployment on OpenStack

### Using Magnum (OpenStack Container Infrastructure Management)

#### Create Cluster Template

```bash
#!/bin/bash
# create-k8s-template.sh

source /etc/kolla/admin-openrc.sh

# Create keypair for cluster access
openstack keypair create --public-key ~/.ssh/id_rsa.pub k8s-keypair

# Create cluster template
openstack coe cluster template create k8s-production \
  --image fedora-coreos \
  --external-network public \
  --dns-nameserver 8.8.8.8 \
  --master-flavor m1.medium \
  --flavor m1.large \
  --volume-driver cinder \
  --network-driver flannel \
  --docker-volume-size 50 \
  --coe kubernetes \
  --labels \
    kube_tag=v1.28.0,\
    cloud_provider_enabled=true,\
    cinder_csi_enabled=true,\
    keystone_auth_enabled=true,\
    auto_healing_enabled=true,\
    auto_scaling_enabled=true,\
    monitoring_enabled=true,\
    ingress_controller=nginx,\
    tiller_enabled=true,\
    container_runtime=containerd,\
    admission_control_list="NamespaceLifecycle,LimitRanger,ServiceAccount,DefaultStorageClass,DefaultTolerationSeconds,MutatingAdmissionWebhook,ValidatingAdmissionWebhook,ResourceQuota,PodSecurityPolicy"

# Create production cluster
openstack coe cluster create k8s-prod \
  --cluster-template k8s-production \
  --master-count 3 \
  --node-count 10 \
  --keypair k8s-keypair

# Wait for cluster to be created
echo "Waiting for cluster creation..."
while true; do
  STATUS=$(openstack coe cluster show k8s-prod -f value -c status)
  echo "Cluster status: $STATUS"

  if [ "$STATUS" == "CREATE_COMPLETE" ]; then
    echo "Cluster created successfully"
    break
  elif [ "$STATUS" == "CREATE_FAILED" ]; then
    echo "Cluster creation failed"
    openstack coe cluster show k8s-prod
    exit 1
  fi

  sleep 30
done

# Get kubeconfig
openstack coe cluster config k8s-prod --dir ~/.kube

# Test cluster access
export KUBECONFIG=~/.kube/config
kubectl get nodes
kubectl get pods -A
```

### Manual Kubernetes Deployment with Kubespray

#### Terraform Configuration for OpenStack VMs

```hcl
# kubernetes-vms.tf
terraform {
  required_providers {
    openstack = {
      source  = "terraform-provider-openstack/openstack"
      version = "~> 1.51.0"
    }
  }
}

provider "openstack" {
  cloud = "production"
}

variable "cluster_name" {
  default = "k8s-prod"
}

variable "master_count" {
  default = 3
}

variable "worker_count" {
  default = 10
}

# Network resources
resource "openstack_networking_network_v2" "k8s_network" {
  name           = "${var.cluster_name}-network"
  admin_state_up = true
}

resource "openstack_networking_subnet_v2" "k8s_subnet" {
  name       = "${var.cluster_name}-subnet"
  network_id = openstack_networking_network_v2.k8s_network.id
  cidr       = "192.168.10.0/24"
  ip_version = 4
  dns_nameservers = ["8.8.8.8", "8.8.4.4"]
}

resource "openstack_networking_router_v2" "k8s_router" {
  name                = "${var.cluster_name}-router"
  external_network_id = data.openstack_networking_network_v2.external.id
}

resource "openstack_networking_router_interface_v2" "k8s_router_interface" {
  router_id = openstack_networking_router_v2.k8s_router.id
  subnet_id = openstack_networking_subnet_v2.k8s_subnet.id
}

data "openstack_networking_network_v2" "external" {
  name = "public"
}

# Security groups
resource "openstack_networking_secgroup_v2" "k8s_master" {
  name        = "${var.cluster_name}-master-sg"
  description = "Security group for Kubernetes masters"
}

resource "openstack_networking_secgroup_rule_v2" "k8s_master_api" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 6443
  port_range_max    = 6443
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = openstack_networking_secgroup_v2.k8s_master.id
}

resource "openstack_networking_secgroup_rule_v2" "k8s_master_internal" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  port_range_min    = 1
  port_range_max    = 65535
  remote_group_id   = openstack_networking_secgroup_v2.k8s_master.id
  security_group_id = openstack_networking_secgroup_v2.k8s_master.id
}

# Master nodes
resource "openstack_compute_instance_v2" "k8s_master" {
  count           = var.master_count
  name            = "${var.cluster_name}-master-${count.index + 1}"
  flavor_name     = "m1.large"
  key_pair        = "k8s-keypair"
  security_groups = [openstack_networking_secgroup_v2.k8s_master.name]

  block_device {
    uuid                  = data.openstack_images_image_v2.ubuntu.id
    source_type           = "image"
    destination_type      = "volume"
    boot_index            = 0
    volume_size           = 100
    delete_on_termination = true
  }

  network {
    uuid = openstack_networking_network_v2.k8s_network.id
  }

  metadata = {
    cluster = var.cluster_name
    role    = "master"
  }
}

# Worker nodes
resource "openstack_compute_instance_v2" "k8s_worker" {
  count           = var.worker_count
  name            = "${var.cluster_name}-worker-${count.index + 1}"
  flavor_name     = "m1.xlarge"
  key_pair        = "k8s-keypair"
  security_groups = [openstack_networking_secgroup_v2.k8s_master.name]

  block_device {
    uuid                  = data.openstack_images_image_v2.ubuntu.id
    source_type           = "image"
    destination_type      = "volume"
    boot_index            = 0
    volume_size           = 200
    delete_on_termination = true
  }

  network {
    uuid = openstack_networking_network_v2.k8s_network.id
  }

  metadata = {
    cluster = var.cluster_name
    role    = "worker"
  }
}

data "openstack_images_image_v2" "ubuntu" {
  name        = "ubuntu-22.04"
  most_recent = true
}

# Floating IPs for masters
resource "openstack_networking_floatingip_v2" "k8s_master" {
  count = var.master_count
  pool  = "public"
}

resource "openstack_compute_floatingip_associate_v2" "k8s_master" {
  count       = var.master_count
  floating_ip = openstack_networking_floatingip_v2.k8s_master[count.index].address
  instance_id = openstack_compute_instance_v2.k8s_master[count.index].id
}

# Load balancer for API
resource "openstack_lb_loadbalancer_v2" "k8s_api_lb" {
  name          = "${var.cluster_name}-api-lb"
  vip_subnet_id = openstack_networking_subnet_v2.k8s_subnet.id
}

resource "openstack_lb_listener_v2" "k8s_api_listener" {
  name            = "${var.cluster_name}-api-listener"
  protocol        = "TCP"
  protocol_port   = 6443
  loadbalancer_id = openstack_lb_loadbalancer_v2.k8s_api_lb.id
}

resource "openstack_lb_pool_v2" "k8s_api_pool" {
  name        = "${var.cluster_name}-api-pool"
  protocol    = "TCP"
  lb_method   = "ROUND_ROBIN"
  listener_id = openstack_lb_listener_v2.k8s_api_listener.id
}

resource "openstack_lb_member_v2" "k8s_api_members" {
  count         = var.master_count
  pool_id       = openstack_lb_pool_v2.k8s_api_pool.id
  address       = openstack_compute_instance_v2.k8s_master[count.index].access_ip_v4
  protocol_port = 6443
  subnet_id     = openstack_networking_subnet_v2.k8s_subnet.id
}

resource "openstack_lb_monitor_v2" "k8s_api_monitor" {
  pool_id     = openstack_lb_pool_v2.k8s_api_pool.id
  type        = "TCP"
  delay       = 5
  timeout     = 3
  max_retries = 3
}

# Outputs
output "master_ips" {
  value = openstack_compute_instance_v2.k8s_master[*].access_ip_v4
}

output "master_floating_ips" {
  value = openstack_networking_floatingip_v2.k8s_master[*].address
}

output "worker_ips" {
  value = openstack_compute_instance_v2.k8s_worker[*].access_ip_v4
}

output "api_lb_vip" {
  value = openstack_lb_loadbalancer_v2.k8s_api_lb.vip_address
}
```

## OpenStack Cloud Provider Integration

### Kubernetes Cloud Config

```yaml
# cloud-config.yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloud-config
  namespace: kube-system
type: Opaque
stringData:
  cloud.conf: |
    [Global]
    auth-url = https://openstack.example.com:5000/v3
    username = k8s-cloud-provider
    password = <PASSWORD>
    tenant-name = kubernetes
    domain-name = Default
    region = RegionOne

    [LoadBalancer]
    use-octavia = true
    subnet-id = <SUBNET_ID>
    floating-network-id = <FLOATING_NETWORK_ID>
    lb-method = ROUND_ROBIN
    lb-provider = amphora
    create-monitor = true
    monitor-delay = 5s
    monitor-timeout = 3s
    monitor-max-retries = 3

    [BlockStorage]
    bs-version = v3
    ignore-volume-az = true

    [Networking]
    ipv6-support-disabled = false
    public-network-name = public
    internal-network-name = kubernetes-internal

    [Metadata]
    search-order = configDrive,metadataService

    [Route]
    router-id = <ROUTER_ID>
```

### OpenStack Cloud Controller Manager Deployment

```yaml
# openstack-cloud-controller-manager.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cloud-controller-manager
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: system:cloud-controller-manager
rules:
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["get", "create", "update"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch", "update"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["*"]
- apiGroups: [""]
  resources: ["nodes/status"]
  verbs: ["patch"]
- apiGroups: [""]
  resources: ["services"]
  verbs: ["list", "patch", "update", "watch"]
- apiGroups: [""]
  resources: ["services/status"]
  verbs: ["patch"]
- apiGroups: [""]
  resources: ["serviceaccounts"]
  verbs: ["create", "get"]
- apiGroups: [""]
  resources: ["persistentvolumes"]
  verbs: ["*"]
- apiGroups: [""]
  resources: ["endpoints"]
  verbs: ["create", "get", "list", "watch", "update"]
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["list", "get", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system:cloud-controller-manager
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:cloud-controller-manager
subjects:
- kind: ServiceAccount
  name: cloud-controller-manager
  namespace: kube-system
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: openstack-cloud-controller-manager
  namespace: kube-system
  labels:
    k8s-app: openstack-cloud-controller-manager
spec:
  selector:
    matchLabels:
      k8s-app: openstack-cloud-controller-manager
  updateStrategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        k8s-app: openstack-cloud-controller-manager
    spec:
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
      - key: node.cloudprovider.kubernetes.io/uninitialized
        value: "true"
        effect: NoSchedule
      - key: node-role.kubernetes.io/master
        effect: NoSchedule
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      serviceAccountName: cloud-controller-manager
      containers:
        - name: openstack-cloud-controller-manager
          image: docker.io/k8scloudprovider/openstack-cloud-controller-manager:v1.28.0
          args:
            - /bin/openstack-cloud-controller-manager
            - --v=4
            - --cloud-config=/etc/config/cloud.conf
            - --cloud-provider=openstack
            - --use-service-account-credentials=true
            - --bind-address=127.0.0.1
          volumeMounts:
            - mountPath: /etc/config
              name: cloud-config
              readOnly: true
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
      hostNetwork: true
      volumes:
      - name: cloud-config
        secret:
          secretName: cloud-config
```

### Cinder CSI Driver

```yaml
# cinder-csi-plugin.yaml
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: csi-cinder-high-performance
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: cinder.csi.openstack.org
parameters:
  type: high-performance
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: csi-cinder-standard
provisioner: cinder.csi.openstack.org
parameters:
  type: standard
allowVolumeExpansion: true
volumeBindingMode: Immediate
---
kind: DaemonSet
apiVersion: apps/v1
metadata:
  name: csi-cinder-nodeplugin
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: csi-cinder-nodeplugin
  template:
    metadata:
      labels:
        app: csi-cinder-nodeplugin
    spec:
      serviceAccount: csi-cinder-node-sa
      hostNetwork: true
      containers:
        - name: node-driver-registrar
          image: k8s.gcr.io/sig-storage/csi-node-driver-registrar:v2.8.0
          args:
            - "--csi-address=$(ADDRESS)"
            - "--kubelet-registration-path=$(DRIVER_REG_SOCK_PATH)"
          env:
            - name: ADDRESS
              value: /csi/csi.sock
            - name: DRIVER_REG_SOCK_PATH
              value: /var/lib/kubelet/plugins/cinder.csi.openstack.org/csi.sock
            - name: KUBE_NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
            - name: registration-dir
              mountPath: /registration
        - name: cinder-csi-plugin
          image: docker.io/k8scloudprovider/cinder-csi-plugin:v1.28.0
          args:
            - /bin/cinder-csi-plugin
            - "--endpoint=$(CSI_ENDPOINT)"
            - "--cloud-config=/etc/config/cloud.conf"
            - "--v=5"
          env:
            - name: CSI_ENDPOINT
              value: unix://csi/csi.sock
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
            - name: kubelet-dir
              mountPath: /var/lib/kubelet
              mountPropagation: "Bidirectional"
            - name: pods-probe-dir
              mountPath: /dev
              mountPropagation: "HostToContainer"
            - name: cloud-config
              mountPath: /etc/config
              readOnly: true
          securityContext:
            privileged: true
            capabilities:
              add: ["SYS_ADMIN"]
            allowPrivilegeEscalation: true
      volumes:
        - name: socket-dir
          hostPath:
            path: /var/lib/kubelet/plugins/cinder.csi.openstack.org
            type: DirectoryOrCreate
        - name: registration-dir
          hostPath:
            path: /var/lib/kubelet/plugins_registry
            type: Directory
        - name: kubelet-dir
          hostPath:
            path: /var/lib/kubelet
            type: Directory
        - name: pods-probe-dir
          hostPath:
            path: /dev
            type: Directory
        - name: cloud-config
          secret:
            secretName: cloud-config
---
kind: StatefulSet
apiVersion: apps/v1
metadata:
  name: csi-cinder-controllerplugin
  namespace: kube-system
spec:
  serviceName: "csi-cinder-controller-service"
  replicas: 1
  selector:
    matchLabels:
      app: csi-cinder-controllerplugin
  template:
    metadata:
      labels:
        app: csi-cinder-controllerplugin
    spec:
      serviceAccount: csi-cinder-controller-sa
      containers:
        - name: csi-attacher
          image: k8s.gcr.io/sig-storage/csi-attacher:v4.3.0
          args:
            - "--csi-address=$(ADDRESS)"
            - "--timeout=3m"
            - "--leader-election=true"
          env:
            - name: ADDRESS
              value: /var/lib/csi/sockets/pluginproxy/csi.sock
          volumeMounts:
            - name: socket-dir
              mountPath: /var/lib/csi/sockets/pluginproxy/
        - name: csi-provisioner
          image: k8s.gcr.io/sig-storage/csi-provisioner:v3.5.0
          args:
            - "--csi-address=$(ADDRESS)"
            - "--timeout=3m"
            - "--extra-create-metadata"
            - "--leader-election=true"
            - "--default-fstype=ext4"
          env:
            - name: ADDRESS
              value: /var/lib/csi/sockets/pluginproxy/csi.sock
          volumeMounts:
            - name: socket-dir
              mountPath: /var/lib/csi/sockets/pluginproxy/
        - name: csi-snapshotter
          image: k8s.gcr.io/sig-storage/csi-snapshotter:v6.2.2
          args:
            - "--csi-address=$(ADDRESS)"
            - "--timeout=3m"
            - "--leader-election=true"
          env:
            - name: ADDRESS
              value: /var/lib/csi/sockets/pluginproxy/csi.sock
          volumeMounts:
            - mountPath: /var/lib/csi/sockets/pluginproxy/
              name: socket-dir
        - name: csi-resizer
          image: k8s.gcr.io/sig-storage/csi-resizer:v1.8.0
          args:
            - "--csi-address=$(ADDRESS)"
            - "--timeout=3m"
            - "--handle-volume-inuse-error=false"
            - "--leader-election=true"
          env:
            - name: ADDRESS
              value: /var/lib/csi/sockets/pluginproxy/csi.sock
          volumeMounts:
            - name: socket-dir
              mountPath: /var/lib/csi/sockets/pluginproxy/
        - name: liveness-probe
          image: k8s.gcr.io/sig-storage/livenessprobe:v2.10.0
          args:
            - "--csi-address=$(ADDRESS)"
          env:
            - name: ADDRESS
              value: /var/lib/csi/sockets/pluginproxy/csi.sock
          volumeMounts:
            - mountPath: /var/lib/csi/sockets/pluginproxy/
              name: socket-dir
        - name: cinder-csi-plugin
          image: docker.io/k8scloudprovider/cinder-csi-plugin:v1.28.0
          args:
            - /bin/cinder-csi-plugin
            - "--endpoint=$(CSI_ENDPOINT)"
            - "--cloud-config=/etc/config/cloud.conf"
            - "--cluster=$(CLUSTER_NAME)"
            - "--v=5"
          env:
            - name: CSI_ENDPOINT
              value: unix://csi/csi.sock
            - name: CLUSTER_NAME
              value: kubernetes
          volumeMounts:
            - name: socket-dir
              mountPath: /csi
            - name: cloud-config
              mountPath: /etc/config
              readOnly: true
      volumes:
        - name: socket-dir
          emptyDir:
        - name: cloud-config
          secret:
            secretName: cloud-config
```

## Monitoring and Operations

### Prometheus Monitoring Stack

```yaml
# prometheus-values.yaml
prometheus:
  prometheusSpec:
    retention: 30d
    retentionSize: "50GB"
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: csi-cinder-high-performance
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 100Gi

    additionalScrapeConfigs:
    - job_name: 'openstack-exporter'
      static_configs:
      - targets:
        - 'openstack-exporter.monitoring.svc.cluster.local:9180'
      relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: openstack-exporter.monitoring.svc.cluster.local:9180

grafana:
  adminPassword: <SECURE_PASSWORD>
  persistence:
    enabled: true
    storageClassName: csi-cinder-standard
    size: 10Gi

  dashboardProviders:
    dashboardproviders.yaml:
      apiVersion: 1
      providers:
      - name: 'openstack'
        orgId: 1
        folder: 'OpenStack'
        type: file
        disableDeletion: false
        editable: true
        options:
          path: /var/lib/grafana/dashboards/openstack

  datasources:
    datasources.yaml:
      apiVersion: 1
      datasources:
      - name: Prometheus
        type: prometheus
        url: http://prometheus-operated:9090
        access: proxy
        isDefault: true

alertmanager:
  config:
    global:
      resolve_timeout: 5m
    route:
      group_by: ['alertname', 'cluster', 'service']
      group_wait: 10s
      group_interval: 10s
      repeat_interval: 12h
      receiver: 'default'
      routes:
      - match:
          severity: critical
        receiver: critical
        continue: true
    receivers:
    - name: 'default'
      email_configs:
      - to: 'ops-team@example.com'
        from: 'alertmanager@example.com'
        smarthost: 'smtp.example.com:587'
        auth_username: 'alertmanager'
        auth_password: '<PASSWORD>'
    - name: 'critical'
      pagerduty_configs:
      - service_key: '<PAGERDUTY_KEY>'
```

### OpenStack Exporter Deployment

```yaml
# openstack-exporter.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: openstack-exporter-config
  namespace: monitoring
data:
  clouds.yaml: |
    clouds:
      production:
        auth:
          auth_url: https://openstack.example.com:5000/v3
          username: monitoring
          password: <PASSWORD>
          project_name: monitoring
          domain_name: Default
        region_name: RegionOne
        interface: public
        identity_api_version: 3
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openstack-exporter
  namespace: monitoring
spec:
  replicas: 2
  selector:
    matchLabels:
      app: openstack-exporter
  template:
    metadata:
      labels:
        app: openstack-exporter
    spec:
      containers:
      - name: openstack-exporter
        image: ghcr.io/openstack-exporter/openstack-exporter:latest
        args:
        - --os-client-config=/etc/openstack/clouds.yaml
        - --cloud=production
        - --web.listen-address=:9180
        ports:
        - containerPort: 9180
          name: metrics
        volumeMounts:
        - name: config
          mountPath: /etc/openstack
          readOnly: true
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: config
        configMap:
          name: openstack-exporter-config
---
apiVersion: v1
kind: Service
metadata:
  name: openstack-exporter
  namespace: monitoring
  labels:
    app: openstack-exporter
spec:
  ports:
  - port: 9180
    targetPort: metrics
    name: metrics
  selector:
    app: openstack-exporter
```

## Best Practices

### Infrastructure Management

1. **Use Infrastructure as Code**: Manage all infrastructure using Terraform/Ansible
2. **Implement GitOps**: Version control all configurations
3. **Automate Testing**: Regular validation of infrastructure state
4. **Document Architecture**: Maintain up-to-date architecture diagrams

### Security Considerations

1. **Network Segmentation**: Separate management, storage, and tenant networks
2. **Encryption**: TLS for all API communications, encrypted storage backends
3. **Access Control**: RBAC for both OpenStack and Kubernetes
4. **Regular Updates**: Keep all components up to date with security patches

### High Availability

1. **Control Plane**: 3+ controller nodes for OpenStack services
2. **Database**: MariaDB Galera cluster for HA
3. **Message Queue**: RabbitMQ clustering
4. **Storage**: Ceph with 3x replication

### Monitoring and Alerting

1. **Comprehensive Metrics**: Monitor OpenStack, Kubernetes, and infrastructure
2. **Log Aggregation**: Centralized logging for troubleshooting
3. **Automated Alerting**: Proactive issue detection
4. **Regular Health Checks**: Automated validation of system components

## Conclusion

Building a private cloud with OpenStack and Kubernetes provides a powerful, flexible platform for enterprise workloads. This architecture enables organizations to leverage both traditional VM-based applications and modern container workloads while maintaining control over their infrastructure. The integration patterns and deployment strategies outlined in this guide provide a foundation for building production-grade private cloud environments that can scale to meet enterprise requirements.

Key takeaways:
- OpenStack provides robust IaaS capabilities
- Kubernetes integration enables container orchestration
- Cloud provider integration ensures seamless operation
- Comprehensive monitoring ensures operational visibility
- Following best practices ensures reliability and security