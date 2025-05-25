---
title: "Auto-Generating Kubernetes Architecture Diagrams: From Cluster to Documentation in Seconds"
date: 2025-09-02T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Documentation", "Architecture", "DevOps", "KubeDiagrams", "Visualization", "Infrastructure as Code"]
categories:
- Kubernetes
- Documentation
author: "Matthew Mattox - mmattox@support.tools"
description: "How to automatically generate accurate Kubernetes architecture diagrams directly from your live clusters or manifests using KubeDiagrams, eliminating outdated documentation and simplifying knowledge sharing"
more_link: "yes"
url: "/auto-generating-kubernetes-architecture-diagrams/"
---

As a Kubernetes administrator, I've repeatedly faced this scenario: a new engineer joins the team and asks for an architecture diagram of our cluster. I point them to our "documentation" only to realize with embarrassment that the supposedly current diagram shows a setup we abandoned three months ago. If you've ever had to explain "well, this part isn't accurate anymore," then you understand the frustration of keeping architectural documentation in sync with rapidly evolving Kubernetes environments. After countless hours wasted manually updating diagrams, I discovered a solution that has completely transformed how we maintain our cluster documentation.

<!--more-->

## The Documentation Challenge in Kubernetes Environments

In the dynamic world of Kubernetes, documentation decay is a constant battle. With continuous deployments, evolving architectures, and multiple environments (dev, staging, production), keeping diagrams current becomes nearly impossible through manual processes. Every sprint brings new changes:

- New microservices appear
- Services get split or consolidated
- Database backends change
- Ingress paths get reconfigured
- Configuration management evolves
- Monitoring stacks get upgraded

The traditional approach of opening Visio, Draw.io, or Lucidchart and manually adjusting boxes and arrows simply doesn't scale. By the time you finish updating the diagram, something else has changed. This isn't just an annoyance—it creates real operational problems:

1. **Onboarding friction**: New team members struggle to understand the actual system architecture
2. **Troubleshooting delays**: During incidents, teams waste precious time verifying if diagrams reflect reality
3. **Miscommunication**: Different stakeholders have different mental models of the system
4. **Planning errors**: Architecture decisions get made based on outdated information

What we really need is diagrams that automatically reflect the current state of our Kubernetes clusters—documentation that updates itself.

## KubeDiagrams: Automation for the Documentation Problem

After testing several options, I've found that [KubeDiagrams](https://github.com/philippemerle/KubeDiagrams) provides the most straightforward and flexible approach to generating accurate Kubernetes architecture diagrams. This open-source tool creates visual representations directly from your cluster's actual state or from your Kubernetes manifests.

The core principle is simple but transformative: **instead of manually documenting what should be in your cluster, automatically visualize what actually is in your cluster.**

### Key Capabilities That Make KubeDiagrams Powerful

1. **Live Cluster Visualization**: Generate diagrams directly from your running cluster's state
2. **Manifest-Based Visualization**: Create diagrams from YAML files, Helm charts, or Kustomize configs before deployment
3. **Comprehensive Resource Support**: Visualizes 47+ Kubernetes resource types including core components and CRDs
4. **Namespace and Label Grouping**: Automatically organizes resources by namespace and application labels
5. **Multiple Output Formats**: Supports PNG, SVG, PDF, and other formats for different documentation needs
6. **Low-Overhead Operation**: Runs as a simple CLI tool with minimal resource requirements
7. **Integration-Friendly Design**: Easily incorporates into CI/CD pipelines for automatic documentation updates

Let me walk you through how to implement this in your environment and show some practical use cases that have saved my team countless hours.

## Getting Started with KubeDiagrams: Installation and Basic Usage

### Installation Options

You have two main ways to install KubeDiagrams:

**Option 1: Using pip (Python package manager)**

```bash
pip install KubeDiagrams
```

This gives you direct access to the `kube-diagrams` and `helm-diagrams` commands.

**Option 2: Using Docker (no local installation)**

```bash
docker pull philippemerle/kubediagrams
```

Using the Docker approach is ideal for CI/CD pipelines or when you want to avoid installing dependencies.

### Basic Usage: Diagramming a Live Cluster

The most common use case is generating a diagram of your current cluster state. Here's how:

```bash
# Diagram a specific namespace
kubectl get all -n your-namespace -o yaml | kube-diagrams -o namespace-diagram.png -

# Diagram the entire cluster
kubectl get all --all-namespaces -o yaml | kube-diagrams -o cluster-diagram.png -
```

If you're using the Docker version:

```bash
kubectl get all -n your-namespace -o yaml | docker run -i --rm -v $(pwd):/output philippemerle/kubediagrams -o /output/namespace-diagram.png -
```

However, this basic approach only captures core resources (`kubectl get all` is notoriously incomplete). For a more comprehensive diagram, you'll want to include additional resource types:

```bash
# More comprehensive approach
kubectl get all,ingress,configmap,secret,pv,pvc,hpa -n your-namespace -o yaml | kube-diagrams -o complete-diagram.png -
```

### Creating Diagrams from Helm Charts or Manifests

Before deploying a Helm chart to your cluster, you can visualize what it will create:

```bash
# Using the helm-diagrams command for Helm charts
helm-diagrams ./my-chart

# Or for remote charts
helm-diagrams https://charts.bitnami.com/bitnami/nginx
```

For regular manifest files:

```bash
# Single file
kube-diagrams -o application.png application.yaml

# Multiple files
kube-diagrams -o full-app.png manifests/*.yaml

# From kustomize
kustomize build ./overlay/production | kube-diagrams -o production.png -
```

This pre-deployment visualization is invaluable for reviewing architecture changes before they hit your cluster.

## Advanced Techniques: Making KubeDiagrams Work for You

After integrating KubeDiagrams into our workflow, I've developed some advanced patterns that significantly enhance its utility:

### 1. Environment Comparison Script

This script generates diagrams for all environments and places them side by side for easy comparison:

```bash
#!/bin/bash
# Generate diagrams for all environments

# Set up contexts for different environments
DEV_CONTEXT="dev-cluster"
STAGING_CONTEXT="staging-cluster"
PROD_CONTEXT="prod-cluster"

# Function to generate diagram for a specific context
generate_diagram() {
  local context=$1
  local output=$2
  
  echo "Generating diagram for $context..."
  kubectl --context $context get all,ingress,configmap,pvc -A -o yaml | \
    kube-diagrams -o $output -
  
  echo "Diagram created at $output"
}

# Generate diagrams
generate_diagram $DEV_CONTEXT "dev-architecture.png"
generate_diagram $STAGING_CONTEXT "staging-architecture.png"
generate_diagram $PROD_CONTEXT "prod-architecture.png"

# Optionally, create a combined image
montage dev-architecture.png staging-architecture.png prod-architecture.png \
  -geometry +2+2 environment-comparison.png

echo "Environment comparison complete!"
```

This gives us an immediate visual diff across environments, making it easy to spot discrepancies or verify that promotions happened correctly.

### 2. Focused Application Diagrams

For complex clusters, full diagrams can become overwhelming. This technique creates focused diagrams for specific applications:

```bash
#!/bin/bash
# Generate application-specific diagram

APP_LABEL=$1
OUTPUT="$APP_LABEL-architecture.png"

echo "Generating focused diagram for application: $APP_LABEL"

# Get all resources with the specified app label
kubectl get all,ingress,configmap,secret,pvc -l app=$APP_LABEL -A -o yaml | \
  kube-diagrams -o $OUTPUT -

echo "Application diagram created at $OUTPUT"
```

Run with `./app-diagram.sh your-app-name` to get a clean, focused diagram showing just the components of a specific application.

### 3. CI/CD Integration for Always-Current Documentation

One of the most powerful patterns is integrating diagram generation directly into your CI/CD pipeline. Here's an example GitLab CI job:

```yaml
# .gitlab-ci.yml
update-architecture-diagrams:
  stage: documentation
  image: philippemerle/kubediagrams
  script:
    - apt-get update && apt-get install -y curl
    - curl -LO "https://dl.k8s.io/release/stable.txt"
    - curl -LO "https://dl.k8s.io/release/$(cat stable.txt)/bin/linux/amd64/kubectl"
    - chmod +x kubectl && mv kubectl /usr/local/bin/
    # Set up kubeconfig with service account token
    - echo "$KUBE_CONFIG" > kubeconfig
    - export KUBECONFIG=kubeconfig
    # Generate diagrams
    - kubectl get all,ingress,configmap,pvc -n production -o yaml | kube-diagrams -o production-architecture.png -
    - kubectl get all,ingress,configmap,pvc -n staging -o yaml | kube-diagrams -o staging-architecture.png -
  artifacts:
    paths:
      - production-architecture.png
      - staging-architecture.png
  only:
    - main
    - schedules
```

This job automatically updates your architecture diagrams whenever you merge to main or on a scheduled basis (e.g., nightly). The diagrams can then be:

1. Committed back to the repository
2. Published to a documentation site
3. Attached to a wiki page
4. Sent to stakeholders via notification channels

### 4. Pre-Deployment Architecture Reviews

We've integrated diagram generation into our pull request process for significant infrastructure changes:

```yaml
# .github/workflows/architecture-preview.yml
name: Architecture Preview

on:
  pull_request:
    paths:
      - 'kubernetes/**'
      - 'helm/**'

jobs:
  generate-preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
          
      - name: Install KubeDiagrams
        run: pip install KubeDiagrams
        
      - name: Generate Architecture Preview
        run: |
          # For Helm charts
          helm template ./helm/my-application | kube-diagrams -o architecture-preview.png -
          
      - name: Upload Preview
        uses: actions/upload-artifact@v3
        with:
          name: architecture-preview
          path: architecture-preview.png
          
      - name: Comment on PR
        uses: actions/github-script@v6
        with:
          script: |
            const fs = require('fs');
            const { issue: { number: issue_number }, repo: { owner, repo } } = context;
            
            github.rest.issues.createComment({
              issue_number,
              owner,
              repo,
              body: 'Architecture preview was generated. Download the artifact to view it.'
            });
```

This workflow automatically generates a preview of what the architecture will look like after the PR is merged, helping reviewers understand the impact of changes.

## Real-World Use Cases: How KubeDiagrams Solves Common Challenges

Here are four specific scenarios where KubeDiagrams has dramatically improved our operations:

### Scenario 1: Rapid Onboarding of New DevOps Engineers

When a new engineer joined our team, we used to spend days walking them through the architecture. Now, we have an onboarding script that creates:

1. A cluster-wide overview diagram
2. Focused diagrams for each major application
3. Network flow visualizations (showing ingress paths)

The new team member can immediately understand the system visually, accelerating their time to productivity. One engineer commented that "seeing the actual architecture rather than an idealized version" helped them understand the system's evolution and quirks.

### Scenario 2: Incident Response Acceleration

During an outage involving our payment processing service, we ran a quick diagram generation focused on that application:

```bash
kubectl get all,ingress,configmap,secret,pvc -l app=payment-service -A -o yaml | kube-diagrams -o payment-service.png -
```

The resulting diagram immediately revealed that the service was trying to use a ConfigMap that had been deleted. Without the visualization, we might have spent much longer tracing through logs and connections to find the issue.

### Scenario 3: Detecting Configuration Drift

By generating diagrams weekly and storing them in version control, we accidentally discovered an unauthorized change in our production environment. The diagram from week 2 showed an additional service that wasn't present in week 1, which led us to investigate and discover a manually-applied change that bypassed our GitOps workflow.

This discovery prompted us to implement stricter controls and regular drift detection using KubeDiagrams as one of the verification methods.

### Scenario 4: Cross-Team Communication

When our platform team needed to explain a proposed architecture change to the application development teams, we created "before and after" diagrams:

```bash
# Current architecture
kubectl get all,ingress,configmap,pvc -n application -o yaml | kube-diagrams -o before.png -

# Proposed architecture from Helm chart
helm template ./new-architecture --namespace application | kube-diagrams -o after.png -
```

These visual artifacts were far more effective for communication than lengthy technical explanations. The developers could immediately see how the change would affect their services and ask specific questions about the implications.

## Limitations and Considerations

While KubeDiagrams is immensely valuable, there are some limitations to be aware of:

1. **Layout Complexity**: For very large clusters, diagrams can become visually complex. Use filtering and focused diagrams for better readability.

2. **Custom Resources**: While KubeDiagrams handles most custom resources, deeply nested CRDs may not be visualized optimally.

3. **Network Policies**: The visual representation of NetworkPolicies is basic; complex network rules might not be immediately obvious.

4. **Stateful Connections**: Some relationships between resources are stateful or runtime-specific and may not be fully captured.

5. **Resource Requirements**: Generating diagrams for very large clusters can require substantial memory.

## Best Practices for Implementation

Based on our experience, here are some recommendations for implementing KubeDiagrams in your organization:

1. **Start Small**: Begin with a single application or namespace before attempting cluster-wide diagrams.

2. **Use Consistent Labels**: Ensure your resources have consistent app and component labels for better grouping in diagrams.

3. **Create a Diagram Library**: Maintain a versioned repository of diagrams for historical comparison.

4. **Combine with Written Documentation**: Use the diagrams as visual aids alongside written explanations of key components.

5. **Automate Regular Updates**: Set up scheduled jobs to regenerate diagrams at least weekly.

6. **Include in Review Processes**: Make architecture diagram generation part of your PR reviews for infrastructure changes.

## Conclusion: Documentation That Lives with Your Code

KubeDiagrams has fundamentally changed how we think about Kubernetes documentation. Instead of treating architecture diagrams as static artifacts that inevitably become outdated, we now view them as dynamic reflections of our infrastructure that can be regenerated on demand.

This automation-first approach aligns perfectly with the DevOps philosophy: treat your documentation like your code, make it version-controlled, testable, and automatically generated where possible. By connecting our diagrams directly to the source of truth—the cluster itself—we've eliminated an entire category of documentation debt.

For any team running Kubernetes at scale, I strongly recommend adding KubeDiagrams to your toolbox. The minimal effort to implement it pays massive dividends in clarity, communication, and operational efficiency. Your future self (and your teammates) will thank you when they can access an accurate architecture diagram at any time without wondering if it's still valid.

Have you tried automating your Kubernetes architecture documentation? What challenges have you faced with keeping diagrams up to date? I'd love to hear about your experiences in the comments below.