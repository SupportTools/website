---
title: "Spinnaker Multi-Cloud Deployment Strategies: Enterprise Production Guide"
date: 2026-11-26T00:00:00-05:00
draft: false
tags: ["Spinnaker", "Multi-Cloud", "Kubernetes", "CI/CD", "DevOps", "AWS", "GCP"]
categories: ["DevOps", "CI/CD", "Cloud"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Spinnaker multi-cloud deployments with advanced pipeline strategies, canary analysis, automated rollback, and production-ready configurations for enterprise environments."
more_link: "yes"
url: "/spinnaker-multi-cloud-deployment-strategies-enterprise-guide/"
---

Learn how to implement production-grade Spinnaker multi-cloud deployment strategies with advanced pipeline orchestration, automated canary analysis, intelligent rollback mechanisms, and comprehensive monitoring for enterprise Kubernetes environments.

<!--more-->

# Spinnaker Multi-Cloud Deployment Strategies: Enterprise Production Guide

## Executive Summary

Spinnaker has emerged as the leading continuous delivery platform for multi-cloud deployments, originally developed at Netflix and now maintained by the Continuous Delivery Foundation. This comprehensive guide covers production-ready Spinnaker implementations across AWS, GCP, and Azure, with advanced pipeline strategies, automated testing, canary deployments, and disaster recovery procedures for enterprise environments.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Spinnaker Installation and Configuration](#installation-configuration)
3. [Multi-Cloud Provider Integration](#multi-cloud-integration)
4. [Advanced Pipeline Patterns](#pipeline-patterns)
5. [Canary Analysis and Progressive Delivery](#canary-analysis)
6. [Automated Testing and Validation](#automated-testing)
7. [Security and Compliance](#security-compliance)
8. [Monitoring and Observability](#monitoring-observability)
9. [Disaster Recovery](#disaster-recovery)
10. [Performance Optimization](#performance-optimization)

## Architecture Overview {#architecture-overview}

### Spinnaker Components

Spinnaker consists of multiple microservices working together:

```yaml
# Spinnaker Architecture Components
services:
  clouddriver:
    description: "Cloud provider integration and caching"
    responsibilities:
      - Account management
      - Resource caching
      - Mutation operations

  deck:
    description: "UI for Spinnaker"
    responsibilities:
      - User interface
      - Pipeline visualization
      - Manual judgments

  echo:
    description: "Event bus and notification service"
    responsibilities:
      - Pipeline triggers
      - Notifications (Slack, email)
      - Webhooks

  fiat:
    description: "Authorization service"
    responsibilities:
      - RBAC enforcement
      - User permissions
      - Service account authorization

  front50:
    description: "Metadata storage"
    responsibilities:
      - Application config
      - Pipeline definitions
      - Project metadata

  gate:
    description: "API gateway"
    responsibilities:
      - REST API
      - Authentication
      - Request routing

  igor:
    description: "Integration with CI systems"
    responsibilities:
      - Jenkins integration
      - GitHub integration
      - Docker registry monitoring

  kayenta:
    description: "Automated canary analysis"
    responsibilities:
      - Metric collection
      - Statistical analysis
      - Canary scoring

  orca:
    description: "Orchestration engine"
    responsibilities:
      - Pipeline execution
      - Task scheduling
      - Retry logic

  rosco:
    description: "Image bakery"
    responsibilities:
      - Machine image creation
      - Packer integration
      - Image management
```

### Reference Architecture

```yaml
# High-Availability Multi-Cloud Architecture
architecture:
  control_plane:
    location: "GKE cluster in us-central1"
    high_availability: true
    components:
      - clouddriver: 3 replicas
      - orca: 3 replicas
      - echo: 2 replicas
      - gate: 3 replicas
      - front50: 2 replicas
      - igor: 2 replicas
      - kayenta: 2 replicas

  storage:
    metadata:
      type: "Google Cloud SQL (PostgreSQL)"
      high_availability: true
      backup: "Daily automated backups"

    artifact_storage:
      type: "Google Cloud Storage"
      replication: "Multi-region"

    redis:
      type: "Google Cloud Memorystore"
      high_availability: true

  deployment_targets:
    aws:
      - us-east-1: EKS clusters
      - us-west-2: EKS clusters
      - eu-west-1: EKS clusters

    gcp:
      - us-central1: GKE clusters
      - us-east1: GKE clusters
      - europe-west1: GKE clusters

    azure:
      - eastus: AKS clusters
      - westus2: AKS clusters
      - westeurope: AKS clusters
```

## Spinnaker Installation and Configuration {#installation-configuration}

### Halyard-Based Installation

```bash
#!/bin/bash
# install-spinnaker.sh - Production Spinnaker Installation

set -euo pipefail

# Configuration
export SPINNAKER_VERSION="1.32.0"
export NAMESPACE="spinnaker"
export HALYARD_VERSION="1.52.0"

# Install Halyard
curl -O https://raw.githubusercontent.com/spinnaker/halyard/master/install/debian/InstallHalyard.sh
sudo bash InstallHalyard.sh --version ${HALYARD_VERSION}

# Configure Halyard
hal config version edit --version ${SPINNAKER_VERSION}

# Configure storage (GCS example)
hal config storage gcs edit \
  --project ${GCP_PROJECT} \
  --bucket-location us-central1 \
  --bucket spinnaker-${GCP_PROJECT}

hal config storage edit --type gcs

# Configure database
hal config storage sql edit \
  --enabled true

cat > ~/.hal/default/profiles/clouddriver-local.yml <<EOF
sql:
  enabled: true
  connectionPools:
    default:
      default: true
      jdbcUrl: jdbc:postgresql://cloudsql-proxy:5432/clouddriver
      user: clouddriver
      password: ${DB_PASSWORD}
  migration:
    jdbcUrl: jdbc:postgresql://cloudsql-proxy:5432/clouddriver
    user: clouddriver
    password: ${DB_PASSWORD}

redis:
  enabled: true
  connection: redis://redis-master:6379

# Enable caching for better performance
cache:
  writeEnabled: true
EOF

cat > ~/.hal/default/profiles/front50-local.yml <<EOF
sql:
  enabled: true
  connectionPools:
    default:
      default: true
      jdbcUrl: jdbc:postgresql://cloudsql-proxy:5432/front50
      user: front50
      password: ${DB_PASSWORD}
  migration:
    jdbcUrl: jdbc:postgresql://cloudsql-proxy:5432/front50
    user: front50
    password: ${DB_PASSWORD}
EOF

# Configure Kubernetes deployment
hal config deploy edit \
  --type distributed \
  --account-name spinnaker-install \
  --location ${NAMESPACE}

# Apply configuration
hal deploy apply

echo "Spinnaker installation complete"
```

### Kubernetes Deployment with Operator

```yaml
# spinnaker-operator-deployment.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: spinnaker-operator
---
apiVersion: v1
kind: Namespace
metadata:
  name: spinnaker
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spinnaker-operator
  namespace: spinnaker-operator
spec:
  replicas: 1
  selector:
    matchLabels:
      app: spinnaker-operator
  template:
    metadata:
      labels:
        app: spinnaker-operator
    spec:
      serviceAccountName: spinnaker-operator
      containers:
      - name: spinnaker-operator
        image: armory/spinnaker-operator:1.6.0
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        env:
        - name: WATCH_NAMESPACE
          value: "spinnaker"
---
apiVersion: spinnaker.armory.io/v1alpha2
kind: SpinnakerService
metadata:
  name: spinnaker
  namespace: spinnaker
spec:
  spinnakerConfig:
    config:
      version: 1.32.0
      persistentStorage:
        persistentStoreType: gcs
        gcs:
          bucket: spinnaker-artifacts
          project: my-gcp-project
          jsonPath: /var/secrets/gcp/key.json

      providers:
        kubernetes:
          enabled: true
          primaryAccount: production-eks-us-east-1
          accounts:
          - name: production-eks-us-east-1
            requiredGroupMembership: []
            providerVersion: V2
            permissions: {}
            dockerRegistries: []
            configureImagePullSecrets: true
            cacheThreads: 1
            namespaces: []
            omitNamespaces:
            - kube-system
            - kube-public
            kinds: []
            omitKinds: []
            customResources: []
            cachingPolicies: []
            oAuthScopes: []
            onlySpinnakerManaged: false
            kubeconfigFile: /var/secrets/kubeconfig/eks-us-east-1

          - name: production-gke-us-central1
            requiredGroupMembership: []
            providerVersion: V2
            permissions: {}
            dockerRegistries: []
            configureImagePullSecrets: true
            cacheThreads: 1
            namespaces: []
            omitNamespaces:
            - kube-system
            - kube-public
            kubeconfigFile: /var/secrets/kubeconfig/gke-us-central1

          - name: production-aks-eastus
            requiredGroupMembership: []
            providerVersion: V2
            permissions: {}
            dockerRegistries: []
            configureImagePullSecrets: true
            cacheThreads: 1
            namespaces: []
            omitNamespaces:
            - kube-system
            - kube-public
            kubeconfigFile: /var/secrets/kubeconfig/aks-eastus

      features:
        artifacts: true
        pipelineTemplates: true
        managedPipelineTemplatesV2UI: true

      security:
        authn:
          oauth2:
            enabled: true
            client:
              clientId: ${OAUTH_CLIENT_ID}
              clientSecret: ${OAUTH_CLIENT_SECRET}
            provider: GOOGLE

        authz:
          enabled: true
          groupMembership:
            service: GOOGLE
            google:
              credentialsPath: /var/secrets/gcp/key.json

      notifications:
        slack:
          enabled: true
          botName: Spinnaker
          token: ${SLACK_TOKEN}

  expose:
    type: service
    service:
      type: LoadBalancer
      annotations:
        cloud.google.com/load-balancer-type: "Internal"

  accounts:
    dynamic:
      enabled: true

  validation:
    enabled: true

  service-settings:
    clouddriver:
      kubernetes:
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 4000m
            memory: 8Gi

    orca:
      kubernetes:
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi

    echo:
      kubernetes:
        resources:
          requests:
            cpu: 250m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 2Gi

    gate:
      kubernetes:
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
```

## Multi-Cloud Provider Integration {#multi-cloud-integration}

### AWS EKS Integration

```bash
#!/bin/bash
# configure-aws-accounts.sh

set -euo pipefail

# Add AWS EKS accounts
for region in us-east-1 us-west-2 eu-west-1; do
  account_name="production-eks-${region}"

  # Generate kubeconfig
  aws eks update-kubeconfig \
    --region ${region} \
    --name production-cluster \
    --kubeconfig ~/.kube/${account_name}

  # Create Kubernetes secret
  kubectl create secret generic ${account_name}-kubeconfig \
    -n spinnaker \
    --from-file=config=/home/${USER}/.kube/${account_name}

  # Add account to Spinnaker
  hal config provider kubernetes account add ${account_name} \
    --provider-version v2 \
    --kubeconfig-file ~/.kube/${account_name} \
    --only-spinnaker-managed false \
    --omit-namespaces kube-system,kube-public

  hal config provider kubernetes account edit ${account_name} \
    --add-custom-resource certificaterequests \
    --add-custom-resource certificates \
    --add-custom-resource challenges \
    --add-custom-resource orders
done

# Configure AWS ECR integration
hal config provider docker-registry account add aws-ecr-us-east-1 \
  --address ${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com \
  --username AWS \
  --password-command "aws ecr get-login-password --region us-east-1" \
  --repositories my-app

hal deploy apply
```

### GCP GKE Integration

```bash
#!/bin/bash
# configure-gcp-accounts.sh

set -euo pipefail

export GCP_PROJECT="my-gcp-project"

# Add GCP GKE accounts
for region in us-central1 us-east1 europe-west1; do
  account_name="production-gke-${region}"
  cluster_name="production-cluster"

  # Generate kubeconfig
  gcloud container clusters get-credentials ${cluster_name} \
    --region ${region} \
    --project ${GCP_PROJECT}

  # Rename context
  kubectl config rename-context \
    gke_${GCP_PROJECT}_${region}_${cluster_name} \
    ${account_name}

  # Extract to separate file
  kubectl config view --minify --flatten \
    --context=${account_name} > ~/.kube/${account_name}

  # Create Kubernetes secret
  kubectl create secret generic ${account_name}-kubeconfig \
    -n spinnaker \
    --from-file=config=/home/${USER}/.kube/${account_name}

  # Add account to Spinnaker
  hal config provider kubernetes account add ${account_name} \
    --provider-version v2 \
    --kubeconfig-file ~/.kube/${account_name} \
    --only-spinnaker-managed false \
    --omit-namespaces kube-system,kube-public
done

# Configure GCR integration
hal config provider docker-registry account add gcr \
  --address gcr.io \
  --username _json_key \
  --password-file ~/.gcp/key.json \
  --repositories my-gcp-project/my-app

hal deploy apply
```

### Azure AKS Integration

```bash
#!/bin/bash
# configure-azure-accounts.sh

set -euo pipefail

export RESOURCE_GROUP="production-rg"

# Add Azure AKS accounts
for region in eastus westus2 westeurope; do
  account_name="production-aks-${region}"
  cluster_name="production-cluster-${region}"

  # Generate kubeconfig
  az aks get-credentials \
    --resource-group ${RESOURCE_GROUP} \
    --name ${cluster_name} \
    --file ~/.kube/${account_name}

  # Create Kubernetes secret
  kubectl create secret generic ${account_name}-kubeconfig \
    -n spinnaker \
    --from-file=config=/home/${USER}/.kube/${account_name}

  # Add account to Spinnaker
  hal config provider kubernetes account add ${account_name} \
    --provider-version v2 \
    --kubeconfig-file ~/.kube/${account_name} \
    --only-spinnaker-managed false \
    --omit-namespaces kube-system,kube-public
done

# Configure ACR integration
hal config provider docker-registry account add azure-acr \
  --address myregistry.azurecr.io \
  --username ${ACR_USERNAME} \
  --password ${ACR_PASSWORD} \
  --repositories my-app

hal deploy apply
```

## Advanced Pipeline Patterns {#pipeline-patterns}

### Multi-Region Deployment Pipeline

```json
{
  "application": "myapp",
  "name": "Multi-Region Production Deploy",
  "description": "Deploy to multiple regions with automated testing and canary analysis",
  "expectedArtifacts": [
    {
      "defaultArtifact": {
        "artifactAccount": "gcr",
        "id": "docker-image",
        "name": "gcr.io/my-gcp-project/myapp",
        "type": "docker/image"
      },
      "displayName": "Docker Image",
      "id": "docker-artifact",
      "matchArtifact": {
        "artifactAccount": "gcr",
        "name": "gcr.io/my-gcp-project/myapp",
        "type": "docker/image"
      },
      "useDefaultArtifact": false,
      "usePriorArtifact": false
    }
  ],
  "triggers": [
    {
      "account": "gcr",
      "enabled": true,
      "organization": "my-gcp-project",
      "registry": "gcr.io",
      "repository": "my-gcp-project/myapp",
      "tag": "^v[0-9]+\\.[0-9]+\\.[0-9]+$",
      "type": "docker"
    }
  ],
  "stages": [
    {
      "name": "Configuration",
      "type": "evaluateVariables",
      "refId": "1",
      "requisiteStageRefIds": [],
      "variables": [
        {
          "key": "regions",
          "value": "[\"us-east-1\", \"us-central1\", \"eastus\"]"
        },
        {
          "key": "canaryDuration",
          "value": "30"
        },
        {
          "key": "canaryThreshold",
          "value": "90"
        }
      ]
    },
    {
      "name": "Deploy to Staging",
      "type": "deployManifest",
      "refId": "2",
      "requisiteStageRefIds": ["1"],
      "account": "production-gke-us-central1",
      "cloudProvider": "kubernetes",
      "manifestArtifactAccount": "embedded-artifact",
      "moniker": {
        "app": "myapp"
      },
      "namespaceOverride": "staging",
      "skipExpressionEvaluation": false,
      "source": "text",
      "trafficManagement": {
        "enabled": false,
        "options": {
          "enableTraffic": false,
          "namespace": "staging",
          "services": [],
          "strategy": "none"
        }
      },
      "manifests": [
        {
          "apiVersion": "apps/v1",
          "kind": "Deployment",
          "metadata": {
            "name": "myapp",
            "namespace": "staging",
            "labels": {
              "app": "myapp",
              "version": "${trigger.tag}"
            }
          },
          "spec": {
            "replicas": 3,
            "selector": {
              "matchLabels": {
                "app": "myapp"
              }
            },
            "template": {
              "metadata": {
                "labels": {
                  "app": "myapp",
                  "version": "${trigger.tag}"
                },
                "annotations": {
                  "prometheus.io/scrape": "true",
                  "prometheus.io/port": "9090",
                  "prometheus.io/path": "/metrics"
                }
              },
              "spec": {
                "containers": [
                  {
                    "name": "myapp",
                    "image": "gcr.io/my-gcp-project/myapp:${trigger.tag}",
                    "ports": [
                      {
                        "containerPort": 8080,
                        "name": "http"
                      },
                      {
                        "containerPort": 9090,
                        "name": "metrics"
                      }
                    ],
                    "resources": {
                      "requests": {
                        "cpu": "100m",
                        "memory": "128Mi"
                      },
                      "limits": {
                        "cpu": "1000m",
                        "memory": "512Mi"
                      }
                    },
                    "livenessProbe": {
                      "httpGet": {
                        "path": "/health",
                        "port": 8080
                      },
                      "initialDelaySeconds": 30,
                      "periodSeconds": 10
                    },
                    "readinessProbe": {
                      "httpGet": {
                        "path": "/ready",
                        "port": 8080
                      },
                      "initialDelaySeconds": 5,
                      "periodSeconds": 5
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    },
    {
      "name": "Run Integration Tests",
      "type": "jenkins",
      "refId": "3",
      "requisiteStageRefIds": ["2"],
      "master": "jenkins-master",
      "job": "integration-tests",
      "parameters": {
        "ENVIRONMENT": "staging",
        "VERSION": "${trigger.tag}"
      },
      "markUnstableAsSuccessful": false,
      "waitForCompletion": true
    },
    {
      "name": "Deploy Canary - AWS",
      "type": "deployManifest",
      "refId": "4",
      "requisiteStageRefIds": ["3"],
      "account": "production-eks-us-east-1",
      "cloudProvider": "kubernetes",
      "manifestArtifactAccount": "embedded-artifact",
      "moniker": {
        "app": "myapp"
      },
      "namespaceOverride": "production",
      "skipExpressionEvaluation": false,
      "source": "text",
      "trafficManagement": {
        "enabled": true,
        "options": {
          "enableTraffic": true,
          "namespace": "production",
          "services": ["myapp"],
          "strategy": "redblack"
        }
      },
      "manifests": [
        {
          "apiVersion": "apps/v1",
          "kind": "Deployment",
          "metadata": {
            "name": "myapp-canary",
            "namespace": "production",
            "labels": {
              "app": "myapp",
              "version": "${trigger.tag}",
              "track": "canary"
            }
          },
          "spec": {
            "replicas": 1,
            "selector": {
              "matchLabels": {
                "app": "myapp",
                "track": "canary"
              }
            },
            "template": {
              "metadata": {
                "labels": {
                  "app": "myapp",
                  "version": "${trigger.tag}",
                  "track": "canary"
                },
                "annotations": {
                  "prometheus.io/scrape": "true",
                  "prometheus.io/port": "9090"
                }
              },
              "spec": {
                "containers": [
                  {
                    "name": "myapp",
                    "image": "gcr.io/my-gcp-project/myapp:${trigger.tag}",
                    "ports": [
                      {
                        "containerPort": 8080,
                        "name": "http"
                      },
                      {
                        "containerPort": 9090,
                        "name": "metrics"
                      }
                    ],
                    "resources": {
                      "requests": {
                        "cpu": "100m",
                        "memory": "128Mi"
                      },
                      "limits": {
                        "cpu": "1000m",
                        "memory": "512Mi"
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    },
    {
      "name": "Canary Analysis - AWS",
      "type": "kayentaCanary",
      "refId": "5",
      "requisiteStageRefIds": ["4"],
      "analysisType": "realTime",
      "canaryConfig": {
        "canaryAnalysisIntervalMins": "${canaryDuration}",
        "canaryConfigId": "production-canary-config",
        "lifetimeDuration": "PT${canaryDuration}M",
        "metricsAccountName": "prometheus",
        "scopes": [
          {
            "controlLocation": "production-eks-us-east-1",
            "controlScope": "myapp-stable",
            "experimentLocation": "production-eks-us-east-1",
            "experimentScope": "myapp-canary",
            "extendedScopeParams": {
              "namespace": "production"
            }
          }
        ],
        "scoreThresholds": {
          "marginal": "75",
          "pass": "${canaryThreshold}"
        },
        "storageAccountName": "gcs"
      }
    },
    {
      "name": "Promote or Rollback - AWS",
      "type": "checkPreconditions",
      "refId": "6",
      "requisiteStageRefIds": ["5"],
      "preconditions": [
        {
          "context": {
            "expression": "${ #stage('Canary Analysis - AWS')['status'] == 'SUCCEEDED' }",
            "failureMessage": "Canary analysis failed, rolling back deployment"
          },
          "failPipeline": true,
          "type": "expression"
        }
      ]
    },
    {
      "name": "Deploy Production - AWS",
      "type": "deployManifest",
      "refId": "7",
      "requisiteStageRefIds": ["6"],
      "account": "production-eks-us-east-1",
      "cloudProvider": "kubernetes",
      "manifestArtifactAccount": "embedded-artifact",
      "moniker": {
        "app": "myapp"
      },
      "namespaceOverride": "production",
      "skipExpressionEvaluation": false,
      "source": "text",
      "trafficManagement": {
        "enabled": true,
        "options": {
          "enableTraffic": true,
          "namespace": "production",
          "services": ["myapp"],
          "strategy": "redblack"
        }
      },
      "manifests": [
        {
          "apiVersion": "apps/v1",
          "kind": "Deployment",
          "metadata": {
            "name": "myapp",
            "namespace": "production",
            "labels": {
              "app": "myapp",
              "version": "${trigger.tag}"
            }
          },
          "spec": {
            "replicas": 10,
            "selector": {
              "matchLabels": {
                "app": "myapp"
              }
            },
            "template": {
              "metadata": {
                "labels": {
                  "app": "myapp",
                  "version": "${trigger.tag}"
                }
              },
              "spec": {
                "containers": [
                  {
                    "name": "myapp",
                    "image": "gcr.io/my-gcp-project/myapp:${trigger.tag}",
                    "ports": [
                      {
                        "containerPort": 8080,
                        "name": "http"
                      }
                    ],
                    "resources": {
                      "requests": {
                        "cpu": "500m",
                        "memory": "512Mi"
                      },
                      "limits": {
                        "cpu": "2000m",
                        "memory": "2Gi"
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    },
    {
      "name": "Delete Canary - AWS",
      "type": "deleteManifest",
      "refId": "8",
      "requisiteStageRefIds": ["7"],
      "account": "production-eks-us-east-1",
      "cloudProvider": "kubernetes",
      "location": "production",
      "manifestName": "deployment myapp-canary",
      "options": {
        "cascading": true
      }
    },
    {
      "name": "Deploy to GCP",
      "type": "deployManifest",
      "refId": "9",
      "requisiteStageRefIds": ["7"],
      "stageEnabled": {
        "expression": "${ #stage('Deploy Production - AWS')['status'] == 'SUCCEEDED' }",
        "type": "expression"
      },
      "account": "production-gke-us-central1",
      "cloudProvider": "kubernetes",
      "manifestArtifactAccount": "embedded-artifact",
      "moniker": {
        "app": "myapp"
      },
      "namespaceOverride": "production",
      "source": "text",
      "manifests": [
        {
          "apiVersion": "apps/v1",
          "kind": "Deployment",
          "metadata": {
            "name": "myapp",
            "namespace": "production"
          },
          "spec": {
            "replicas": 10,
            "selector": {
              "matchLabels": {
                "app": "myapp"
              }
            },
            "template": {
              "metadata": {
                "labels": {
                  "app": "myapp",
                  "version": "${trigger.tag}"
                }
              },
              "spec": {
                "containers": [
                  {
                    "name": "myapp",
                    "image": "gcr.io/my-gcp-project/myapp:${trigger.tag}",
                    "ports": [
                      {
                        "containerPort": 8080
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
      ]
    },
    {
      "name": "Deploy to Azure",
      "type": "deployManifest",
      "refId": "10",
      "requisiteStageRefIds": ["9"],
      "stageEnabled": {
        "expression": "${ #stage('Deploy to GCP')['status'] == 'SUCCEEDED' }",
        "type": "expression"
      },
      "account": "production-aks-eastus",
      "cloudProvider": "kubernetes",
      "manifestArtifactAccount": "embedded-artifact",
      "moniker": {
        "app": "myapp"
      },
      "namespaceOverride": "production",
      "source": "text",
      "manifests": [
        {
          "apiVersion": "apps/v1",
          "kind": "Deployment",
          "metadata": {
            "name": "myapp",
            "namespace": "production"
          },
          "spec": {
            "replicas": 10,
            "selector": {
              "matchLabels": {
                "app": "myapp"
              }
            },
            "template": {
              "metadata": {
                "labels": {
                  "app": "myapp",
                  "version": "${trigger.tag}"
                }
              },
              "spec": {
                "containers": [
                  {
                    "name": "myapp",
                    "image": "myregistry.azurecr.io/myapp:${trigger.tag}",
                    "ports": [
                      {
                        "containerPort": 8080
                      }
                    ]
                  }
                ]
              }
            }
          }
        }
      ]
    },
    {
      "name": "Notify Success",
      "type": "slack",
      "refId": "11",
      "requisiteStageRefIds": ["10"],
      "message": {
        "text": "Deployment of ${trigger.tag} completed successfully across all regions"
      },
      "channel": "#deployments"
    }
  ]
}
```

## Canary Analysis and Progressive Delivery {#canary-analysis}

### Kayenta Configuration

```yaml
# kayenta-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kayenta-config
  namespace: spinnaker
data:
  kayenta.yml: |
    kayenta:
      spectator:
        webEndpoint:
          enabled: true

      metrics:
        providers:
          prometheus:
            enabled: true
            accounts:
            - name: prometheus
              endpoint:
                baseUrl: http://prometheus-server.monitoring:9090
              supportedTypes:
              - METRICS_STORE

          datadog:
            enabled: true
            accounts:
            - name: datadog
              endpoint:
                baseUrl: https://api.datadoghq.com
              apiKey: ${DATADOG_API_KEY}
              applicationKey: ${DATADOG_APP_KEY}
              supportedTypes:
              - METRICS_STORE

      storage:
        providers:
          gcs:
            enabled: true
            accounts:
            - name: gcs
              project: my-gcp-project
              bucket: kayenta-canary-results
              jsonPath: /var/secrets/gcp/key.json
              supportedTypes:
              - OBJECT_STORE
              - CONFIGURATION_STORE

      judge:
        classifiers:
        - name: mann-whitney
          queryPairs:
            controlLabel: control
            experimentLabel: experiment

      aws:
        enabled: true
        accounts:
        - name: aws-canary
          bucket: kayenta-canary-results
          region: us-east-1
          supportedTypes:
          - OBJECT_STORE
          - CONFIGURATION_STORE
```

### Canary Config Definition

```json
{
  "id": "production-canary-config",
  "name": "Production Canary Configuration",
  "description": "Comprehensive canary analysis for production deployments",
  "application": "myapp",
  "judge": {
    "name": "NetflixACAJudge-v1.0",
    "judgeConfigurations": {}
  },
  "metrics": [
    {
      "name": "Request Rate",
      "query": {
        "type": "prometheus",
        "serviceType": "prometheus",
        "metricName": "request_rate",
        "customInlineTemplate": "sum(rate(http_requests_total{namespace=\"production\",app=\"myapp\",track=\"${scope}\"}[1m]))"
      },
      "groups": ["System"],
      "analysisConfigurations": {
        "canary": {
          "direction": "increase",
          "nanStrategy": "replace",
          "critical": false,
          "mustHaveData": true,
          "effectSize": {
            "allowedIncrease": 1.1,
            "allowedDecrease": 0.9,
            "criticalIncrease": 1.2,
            "criticalDecrease": 0.8
          }
        }
      },
      "scopeName": "default"
    },
    {
      "name": "Error Rate",
      "query": {
        "type": "prometheus",
        "serviceType": "prometheus",
        "metricName": "error_rate",
        "customInlineTemplate": "sum(rate(http_requests_total{namespace=\"production\",app=\"myapp\",track=\"${scope}\",status=~\"5..\"}[1m])) / sum(rate(http_requests_total{namespace=\"production\",app=\"myapp\",track=\"${scope}\"}[1m]))"
      },
      "groups": ["System"],
      "analysisConfigurations": {
        "canary": {
          "direction": "decrease",
          "nanStrategy": "replace",
          "critical": true,
          "mustHaveData": true,
          "effectSize": {
            "allowedIncrease": 1.05,
            "allowedDecrease": 0,
            "criticalIncrease": 1.1,
            "criticalDecrease": 0
          }
        }
      },
      "scopeName": "default"
    },
    {
      "name": "Latency P95",
      "query": {
        "type": "prometheus",
        "serviceType": "prometheus",
        "metricName": "latency_p95",
        "customInlineTemplate": "histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{namespace=\"production\",app=\"myapp\",track=\"${scope}\"}[1m])) by (le))"
      },
      "groups": ["Performance"],
      "analysisConfigurations": {
        "canary": {
          "direction": "decrease",
          "nanStrategy": "replace",
          "critical": true,
          "mustHaveData": true,
          "effectSize": {
            "allowedIncrease": 1.1,
            "allowedDecrease": 0,
            "criticalIncrease": 1.2,
            "criticalDecrease": 0
          }
        }
      },
      "scopeName": "default"
    },
    {
      "name": "CPU Usage",
      "query": {
        "type": "prometheus",
        "serviceType": "prometheus",
        "metricName": "cpu_usage",
        "customInlineTemplate": "sum(rate(container_cpu_usage_seconds_total{namespace=\"production\",pod=~\"myapp-${scope}-.*\"}[1m])) by (pod)"
      },
      "groups": ["Resources"],
      "analysisConfigurations": {
        "canary": {
          "direction": "either",
          "nanStrategy": "replace",
          "critical": false,
          "mustHaveData": true,
          "effectSize": {
            "allowedIncrease": 1.2,
            "allowedDecrease": 0.8,
            "criticalIncrease": 1.5,
            "criticalDecrease": 0.5
          }
        }
      },
      "scopeName": "default"
    },
    {
      "name": "Memory Usage",
      "query": {
        "type": "prometheus",
        "serviceType": "prometheus",
        "metricName": "memory_usage",
        "customInlineTemplate": "sum(container_memory_working_set_bytes{namespace=\"production\",pod=~\"myapp-${scope}-.*\"}) by (pod)"
      },
      "groups": ["Resources"],
      "analysisConfigurations": {
        "canary": {
          "direction": "either",
          "nanStrategy": "replace",
          "critical": false,
          "mustHaveData": true,
          "effectSize": {
            "allowedIncrease": 1.2,
            "allowedDecrease": 0.8,
            "criticalIncrease": 1.5,
            "criticalDecrease": 0.5
          }
        }
      },
      "scopeName": "default"
    }
  ],
  "classifier": {
    "groupWeights": {
      "System": 40,
      "Performance": 40,
      "Resources": 20
    }
  },
  "templates": {}
}
```

## Automated Testing and Validation {#automated-testing}

### Automated Testing Pipeline Stage

```bash
#!/bin/bash
# automated-testing.sh - Comprehensive automated testing

set -euo pipefail

# Configuration
export ENVIRONMENT="${1:-staging}"
export VERSION="${2:-latest}"
export NAMESPACE="$ENVIRONMENT"
export APP_URL="https://myapp-${ENVIRONMENT}.example.com"

echo "Running automated tests for version ${VERSION} in ${ENVIRONMENT}"

# Health check
echo "Performing health check..."
for i in {1..30}; do
  if curl -sf "${APP_URL}/health" > /dev/null; then
    echo "Health check passed"
    break
  fi

  if [ $i -eq 30 ]; then
    echo "Health check failed after 30 attempts"
    exit 1
  fi

  echo "Waiting for application to be ready... ($i/30)"
  sleep 10
done

# Smoke tests
echo "Running smoke tests..."
cat > smoke-tests.yaml <<EOF
tests:
  - name: Homepage Load
    request:
      url: ${APP_URL}/
      method: GET
    expect:
      status: 200
      response_time_ms: 1000

  - name: API Health
    request:
      url: ${APP_URL}/api/health
      method: GET
    expect:
      status: 200
      body_contains: "healthy"

  - name: Metrics Endpoint
    request:
      url: ${APP_URL}/metrics
      method: GET
    expect:
      status: 200
      content_type: "text/plain"
EOF

# Run tests using custom test runner
./run-api-tests.sh smoke-tests.yaml

# Load testing
echo "Running load tests..."
cat > load-test.js <<EOF
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '3m', target: 50 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  let res = http.get('${APP_URL}/api/items');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
  sleep(1);
}
EOF

k6 run --out json=load-test-results.json load-test.js

# Security scanning
echo "Running security scan..."
zap-cli quick-scan --self-contained --start-options '-config api.disablekey=true' "${APP_URL}"

# Integration tests
echo "Running integration tests..."
npm run test:integration -- --env=${ENVIRONMENT} --version=${VERSION}

# Collect results
echo "Test execution complete. Results:"
cat load-test-results.json | jq '.metrics'

exit 0
```

## Security and Compliance {#security-compliance}

### RBAC Configuration

```yaml
# spinnaker-rbac.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fiat-config
  namespace: spinnaker
data:
  fiat-local.yml: |
    auth:
      enabled: true
      groupMembership:
        service: GOOGLE
        google:
          credentialsPath: /var/secrets/gcp/key.json
          adminUsername: admin@example.com
          domain: example.com

    permissions:
      provider:
        application: true

      source:
        google:
          baseUrl: https://www.googleapis.com/admin/directory/v1

    server:
      session:
        timeoutInSeconds: 3600
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: gate-config
  namespace: spinnaker
data:
  gate-local.yml: |
    security:
      authn:
        enabled: true
        oauth2:
          enabled: true
          client:
            clientId: ${OAUTH_CLIENT_ID}
            clientSecret: ${OAUTH_CLIENT_SECRET}
            scope: openid,profile,email
            pre-established-redirect-uri: https://spinnaker.example.com/login
          provider: GOOGLE
          user-info-requirements:
            email: required

      authz:
        enabled: true

      basic:
        enabled: false

    cors:
      allowed-origins-pattern: https://spinnaker\\.example\\.com
```

### Application Permissions

```json
{
  "name": "myapp",
  "description": "Production application with strict RBAC",
  "email": "team@example.com",
  "permissions": {
    "READ": ["spinnaker-read", "myapp-developers"],
    "WRITE": ["myapp-developers", "myapp-sres"],
    "EXECUTE": ["myapp-deployers", "myapp-sres"],
    "CREATE": ["myapp-admin"],
    "DELETE": ["myapp-admin"]
  },
  "requiresGroupPermissions": true
}
```

### Policy Engine Integration

```yaml
# opa-policy.rego
package spinnaker.deployment

import future.keywords.if
import future.keywords.in

# Deny deployment if not approved
deny[msg] {
  input.deploy.type == "deployManifest"
  not approved_for_production
  msg := "Deployment to production requires manual approval"
}

approved_for_production if {
  input.pipeline.trigger.type == "manual"
  input.user.memberOf[_] == "production-deployers"
}

approved_for_production if {
  input.pipeline.authentication.user in allowed_automated_accounts
}

allowed_automated_accounts := ["spinnaker-automation@example.com"]

# Require specific image registry
deny[msg] {
  input.deploy.type == "deployManifest"
  manifest := input.deploy.manifests[_]
  container := manifest.spec.template.spec.containers[_]
  not startswith(container.image, "gcr.io/my-gcp-project/")
  not startswith(container.image, "myregistry.azurecr.io/")
  msg := sprintf("Container image must be from approved registry: %v", [container.image])
}

# Enforce resource limits
deny[msg] {
  input.deploy.type == "deployManifest"
  manifest := input.deploy.manifests[_]
  container := manifest.spec.template.spec.containers[_]
  not container.resources.limits
  msg := "All containers must have resource limits defined"
}

# Require security context
deny[msg] {
  input.deploy.type == "deployManifest"
  manifest := input.deploy.manifests[_]
  not manifest.spec.template.spec.securityContext.runAsNonRoot
  msg := "Containers must run as non-root user"
}
```

## Monitoring and Observability {#monitoring-observability}

### Prometheus Metrics

```yaml
# spinnaker-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: spinnaker
  namespace: spinnaker
  labels:
    app: spinnaker
spec:
  selector:
    matchLabels:
      app: spinnaker
  endpoints:
  - port: metrics
    interval: 30s
    path: /prometheus_metrics
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboards
  namespace: monitoring
data:
  spinnaker-overview.json: |
    {
      "dashboard": {
        "title": "Spinnaker Overview",
        "panels": [
          {
            "title": "Pipeline Executions",
            "targets": [
              {
                "expr": "sum(rate(controller_invocations_total{controller=\"pipelines\"}[5m]))"
              }
            ]
          },
          {
            "title": "Pipeline Success Rate",
            "targets": [
              {
                "expr": "sum(rate(pipelines_completed_total{status=\"SUCCEEDED\"}[5m])) / sum(rate(pipelines_completed_total[5m]))"
              }
            ]
          },
          {
            "title": "Stage Duration P95",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, sum(rate(stage_duration_seconds_bucket[5m])) by (le, stage_type))"
              }
            ]
          },
          {
            "title": "Clouddriver Cache Refresh",
            "targets": [
              {
                "expr": "sum(rate(clouddriver_cache_refresh_duration_seconds_sum[5m])) by (account)"
              }
            ]
          }
        ]
      }
    }
```

### Alerting Rules

```yaml
# spinnaker-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: spinnaker-alerts
  namespace: spinnaker
spec:
  groups:
  - name: spinnaker
    interval: 30s
    rules:
    - alert: SpinnakerPipelineFailureRate
      expr: |
        sum(rate(pipelines_completed_total{status="TERMINAL"}[5m])) by (application)
        /
        sum(rate(pipelines_completed_total[5m])) by (application)
        > 0.1
      for: 5m
      labels:
        severity: warning
        component: spinnaker
      annotations:
        summary: "High pipeline failure rate for {{ $labels.application }}"
        description: "Pipeline failure rate is {{ $value | humanizePercentage }} for application {{ $labels.application }}"

    - alert: SpinnakerServiceDown
      expr: up{job="spinnaker"} == 0
      for: 2m
      labels:
        severity: critical
        component: spinnaker
      annotations:
        summary: "Spinnaker service {{ $labels.instance }} is down"
        description: "Spinnaker service {{ $labels.instance }} has been down for more than 2 minutes"

    - alert: SpinnakerCacheRefreshSlow
      expr: |
        histogram_quantile(0.95,
          sum(rate(clouddriver_cache_refresh_duration_seconds_bucket[5m])) by (le, account)
        ) > 300
      for: 10m
      labels:
        severity: warning
        component: clouddriver
      annotations:
        summary: "Slow cache refresh for account {{ $labels.account }}"
        description: "Cache refresh P95 duration is {{ $value }}s for account {{ $labels.account }}"

    - alert: SpinnakerOrchestrationQueueDepth
      expr: orca_queue_depth > 1000
      for: 5m
      labels:
        severity: warning
        component: orca
      annotations:
        summary: "High orchestration queue depth"
        description: "Orca queue depth is {{ $value }}, indicating potential processing delays"
```

## Disaster Recovery {#disaster-recovery}

### Backup Strategy

```bash
#!/bin/bash
# backup-spinnaker.sh - Complete Spinnaker backup

set -euo pipefail

export BACKUP_DIR="/backups/spinnaker/$(date +%Y%m%d-%H%M%S)"
export GCS_BUCKET="gs://spinnaker-backups"
export NAMESPACE="spinnaker"

echo "Creating backup directory: ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

# Backup Front50 (application and pipeline configs)
echo "Backing up Front50 data..."
kubectl exec -n ${NAMESPACE} \
  $(kubectl get pod -n ${NAMESPACE} -l app=spin-front50 -o jsonpath='{.items[0].metadata.name}') \
  -- bash -c "pg_dump -h cloudsql-proxy -U front50 front50" \
  > "${BACKUP_DIR}/front50.sql"

# Backup Clouddriver (infrastructure cache)
echo "Backing up Clouddriver data..."
kubectl exec -n ${NAMESPACE} \
  $(kubectl get pod -n ${NAMESPACE} -l app=spin-clouddriver -o jsonpath='{.items[0].metadata.name}') \
  -- bash -c "pg_dump -h cloudsql-proxy -U clouddriver clouddriver" \
  > "${BACKUP_DIR}/clouddriver.sql"

# Backup Orca (pipeline execution history)
echo "Backing up Orca data..."
kubectl exec -n ${NAMESPACE} \
  $(kubectl get pod -n ${NAMESPACE} -l app=spin-orca -o jsonpath='{.items[0].metadata.name}') \
  -- bash -c "pg_dump -h cloudsql-proxy -U orca orca" \
  > "${BACKUP_DIR}/orca.sql"

# Backup Redis data
echo "Backing up Redis data..."
kubectl exec -n ${NAMESPACE} redis-master-0 \
  -- redis-cli --rdb /tmp/dump.rdb BGSAVE

sleep 10

kubectl cp ${NAMESPACE}/redis-master-0:/tmp/dump.rdb \
  "${BACKUP_DIR}/redis-dump.rdb"

# Backup Halyard configuration
echo "Backing up Halyard configuration..."
kubectl exec -n ${NAMESPACE} \
  $(kubectl get pod -n ${NAMESPACE} -l app=halyard -o jsonpath='{.items[0].metadata.name}') \
  -- tar czf - /home/spinnaker/.hal \
  > "${BACKUP_DIR}/halyard-config.tar.gz"

# Backup Kubernetes resources
echo "Backing up Kubernetes resources..."
kubectl get all,configmap,secret,pvc -n ${NAMESPACE} -o yaml \
  > "${BACKUP_DIR}/kubernetes-resources.yaml"

# Upload to GCS
echo "Uploading backup to GCS..."
gsutil -m cp -r "${BACKUP_DIR}" "${GCS_BUCKET}/"

# Cleanup old backups (keep 30 days)
echo "Cleaning up old backups..."
find /backups/spinnaker -type d -mtime +30 -exec rm -rf {} +

gsutil -m rm -r \
  "$(gsutil ls ${GCS_BUCKET}/ | head -n -30)"

echo "Backup completed successfully: ${BACKUP_DIR}"
```

### Restore Procedure

```bash
#!/bin/bash
# restore-spinnaker.sh - Restore Spinnaker from backup

set -euo pipefail

export BACKUP_DATE="${1:-latest}"
export GCS_BUCKET="gs://spinnaker-backups"
export NAMESPACE="spinnaker"
export RESTORE_DIR="/tmp/spinnaker-restore"

if [ "$BACKUP_DATE" == "latest" ]; then
  BACKUP_PATH=$(gsutil ls ${GCS_BUCKET}/ | tail -n 1)
else
  BACKUP_PATH="${GCS_BUCKET}/${BACKUP_DATE}"
fi

echo "Restoring from backup: ${BACKUP_PATH}"

# Download backup
mkdir -p "${RESTORE_DIR}"
gsutil -m cp -r "${BACKUP_PATH}/*" "${RESTORE_DIR}/"

# Scale down Spinnaker services
echo "Scaling down Spinnaker services..."
kubectl scale deployment -n ${NAMESPACE} --all --replicas=0

# Wait for pods to terminate
kubectl wait --for=delete pod -n ${NAMESPACE} --all --timeout=300s

# Restore databases
echo "Restoring Front50 database..."
kubectl exec -n ${NAMESPACE} cloudsql-proxy-0 \
  -- psql -h localhost -U postgres \
  -c "DROP DATABASE IF EXISTS front50; CREATE DATABASE front50;"

cat "${RESTORE_DIR}/front50.sql" | kubectl exec -i -n ${NAMESPACE} cloudsql-proxy-0 \
  -- psql -h localhost -U front50 front50

echo "Restoring Clouddriver database..."
kubectl exec -n ${NAMESPACE} cloudsql-proxy-0 \
  -- psql -h localhost -U postgres \
  -c "DROP DATABASE IF EXISTS clouddriver; CREATE DATABASE clouddriver;"

cat "${RESTORE_DIR}/clouddriver.sql" | kubectl exec -i -n ${NAMESPACE} cloudsql-proxy-0 \
  -- psql -h localhost -U clouddriver clouddriver

echo "Restoring Orca database..."
kubectl exec -n ${NAMESPACE} cloudsql-proxy-0 \
  -- psql -h localhost -U postgres \
  -c "DROP DATABASE IF EXISTS orca; CREATE DATABASE orca;"

cat "${RESTORE_DIR}/orca.sql" | kubectl exec -i -n ${NAMESPACE} cloudsql-proxy-0 \
  -- psql -h localhost -U orca orca

# Restore Redis
echo "Restoring Redis data..."
kubectl cp "${RESTORE_DIR}/redis-dump.rdb" \
  ${NAMESPACE}/redis-master-0:/tmp/dump.rdb

kubectl exec -n ${NAMESPACE} redis-master-0 \
  -- redis-cli DEBUG RELOAD

# Scale up Spinnaker services
echo "Scaling up Spinnaker services..."
kubectl scale deployment -n ${NAMESPACE} --all --replicas=1

# Wait for services to be ready
kubectl wait --for=condition=ready pod -n ${NAMESPACE} --all --timeout=600s

echo "Restore completed successfully"
```

## Performance Optimization {#performance-optimization}

### Clouddriver Optimization

```yaml
# clouddriver-performance.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: clouddriver-config
  namespace: spinnaker
data:
  clouddriver-local.yml: |
    # Cache configuration
    caching:
      write-enabled: true

    # Reduce caching intervals for better performance
    kubernetes:
      cache:
        cacheIntervalSeconds: 30
        cacheThreads: 4

    # Connection pool optimization
    sql:
      connectionPools:
        default:
          default: true
          jdbcUrl: jdbc:postgresql://cloudsql-proxy:5432/clouddriver
          maxPoolSize: 20
          minIdle: 5
          connectionTimeout: 5000

    # Redis optimization
    redis:
      connection: redis://redis-master:6379
      timeout: 2000
      poolConfig:
        maxTotal: 100
        maxIdle: 100
        minIdle: 25

    # Async configuration
    executors:
      write:
        corePoolSize: 10
        maxPoolSize: 50
        queueSize: 500
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spin-clouddriver
  namespace: spinnaker
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: clouddriver
        resources:
          requests:
            cpu: 2000m
            memory: 4Gi
          limits:
            cpu: 4000m
            memory: 8Gi
        env:
        - name: JAVA_OPTS
          value: |
            -XX:+UseG1GC
            -XX:MaxGCPauseMillis=100
            -XX:+ParallelRefProcEnabled
            -XX:+UseStringDeduplication
            -Xms4g
            -Xmx6g
```

### Orca Optimization

```yaml
# orca-performance.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: orca-config
  namespace: spinnaker
data:
  orca-local.yml: |
    # Queue optimization
    queue:
      zombieCheck:
        enabled: true
        cutoffMinutes: 10
      retry:
        maxAttempts: 3
        backoffMs: 30000

    # Task executor configuration
    tasks:
      executionWindow:
        days: 3
      daysOfExecutionHistory: 14

    # Monitoring configuration
    monitor:
      activeExecutions:
        redis: true

    # Performance tuning
    executors:
      default:
        corePoolSize: 20
        maxPoolSize: 100
        queueCapacity: 500
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spin-orca
  namespace: spinnaker
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: orca
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        env:
        - name: JAVA_OPTS
          value: |
            -XX:+UseG1GC
            -XX:MaxGCPauseMillis=100
            -Xms2g
            -Xmx3g
```

## Conclusion

Spinnaker provides a powerful, enterprise-grade platform for multi-cloud continuous delivery with advanced features like automated canary analysis, comprehensive RBAC, and extensive monitoring capabilities. This guide has covered production-ready configurations, advanced pipeline patterns, security best practices, and performance optimization strategies.

Key takeaways:

1. **Multi-Cloud Strategy**: Leverage Spinnaker's provider-agnostic approach for consistent deployments across AWS, GCP, and Azure
2. **Progressive Delivery**: Use canary analysis and automated rollback to minimize deployment risk
3. **Security**: Implement comprehensive RBAC and policy enforcement for enterprise compliance
4. **Observability**: Monitor pipeline execution, cache performance, and system health with Prometheus and Grafana
5. **Performance**: Optimize Clouddriver caching and Orca execution for large-scale deployments
6. **Disaster Recovery**: Maintain regular backups and tested restore procedures

For more information on CI/CD and deployment strategies, see our guides on [GitOps with ArgoCD and Flux](/advanced-gitops-implementation-argocd-flux-enterprise-guide/) and [Kubernetes deployment strategies](/advanced-deployment-strategies-blue-green-canary-rolling-updates/).