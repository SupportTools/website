title: "Announcing DR-Syncer v0.1.0: Simplifying Kubernetes Disaster Recovery"
date: 2025-03-13T01:00:00-05:00
draft: false
tags: ["Kubernetes", "Disaster Recovery", "DevOps", "DR-Syncer"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Introducing DR-Syncer v0.1.0, a new tool designed to automate and simplify disaster recovery synchronization between Kubernetes clusters."
more_link: "yes"
url: "/announcing-dr-syncer-v0.1.0/"
---

We're excited to announce the initial release of DR-Syncer v0.1.0, a powerful new tool designed to automate and simplify disaster recovery synchronization between Kubernetes clusters.

<!--more-->

# Introducing DR-Syncer v0.1.0

Organizations running Kubernetes in production face several challenges when establishing and maintaining disaster recovery environments. Manual configuration is time-consuming and error-prone, resource management is complex, and operational overhead is significant. DR-Syncer addresses these challenges by providing automated, reliable disaster recovery setups with minimal operational overhead.

## Key Features in v0.1.0

### Two Distinct Tools for Flexibility

DR-Syncer offers two complementary approaches to disaster recovery:

1. **Controller**: A Kubernetes operator that runs continuously inside your cluster
   - Automated and scheduled synchronization 
   - Uses Custom Resource Definitions (CRDs) for configuration
   - Supports continuous, scheduled, and manual sync modes

2. **CLI**: A standalone command-line tool for direct, on-demand operations
   - No controller deployment required
   - Perfect for manual operations, testing, or one-off scenarios
   - Supports Stage, Cutover, and Failback operations

### Core Capabilities

- **Resource Synchronization**
  - Synchronizes ConfigMaps, Secrets, Deployments, Services, Ingresses, and PVCs
  - Maintains resource state and metadata across clusters
  - Handles immutable fields and resource versions

- **Deployment Strategies**
  - Zero replicas in DR cluster by default (saving resources)
  - Scale override capability via `dr-syncer.io/scale-override` label
  - Original replica count preservation (stored in annotations)

- **Multiple Synchronization Modes**
  - Manual sync (on-demand)
  - Scheduled sync (cron-based)
  - Continuous sync (real-time monitoring)

- **PVC Data Replication**
  - Cross-cluster PVC data synchronization using rsync
  - Secure SSH-based transfer mechanism
  - Storage class mapping for different cluster environments

## Benefits for Kubernetes Administrators

- **Reduced Manual Effort**: Automate the repetitive tasks of maintaining DR environments
- **Improved Consistency**: Ensure your DR environment accurately reflects production
- **Operational Simplicity**: Choose between controller-based or CLI approaches based on your needs
- **Flexible Scheduling**: Configure synchronization on your preferred schedule
- **Fine-Grained Control**: Include or exclude specific resources and types

## Getting Started

### Controller Installation with Helm

```bash
# Add the DR-Syncer Helm repository
helm repo add dr-syncer https://supporttools.github.io/dr-syncer/charts

# Update repositories
helm repo update

# Install DR-Syncer
helm install dr-syncer dr-syncer/dr-syncer \
  --namespace dr-syncer-system \
  --create-namespace
```

### CLI Installation

Build the CLI binary:

```bash
make build
```

This will create the `dr-syncer-cli` binary in the `bin/` directory.

## What's Next for DR-Syncer

Our roadmap includes:

- Enhanced monitoring capabilities
- Advanced filtering options
- Performance optimizations
- Security enhancements
- Community features and plugin system

## Join the Community

We welcome contributions from the community! Check out our [GitHub repository](https://github.com/supporttools/dr-syncer) to:

- Report bugs or request features
- Contribute code or documentation
- Provide feedback

For comprehensive documentation, visit our [documentation site](https://supporttools.github.io/dr-syncer/).

Stay tuned for more updates as we continue to improve DR-Syncer!
