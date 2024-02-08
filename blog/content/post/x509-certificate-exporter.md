---
title: "Monitoring RKE2 certs with x509-certificate-exporter"
date: 2024-02-08T03:24:00-05:00
draft: false
tags: ["RKE2", "Prometheus", "Grafana"]
categories:
- RKE2
- Prometheus
- Grafana
author: "Matthew Mattox - mmattox@support.tools."
description: "Monitoring the expiration of RKE2 certificates with x509-certificate-exporter including the TLS secrets that store as Kubernetes secrets."
more_link: "yes"
---

Monitoring the validity of SSL/TLS certificates is crucial in maintaining the security and reliability of any Kubernetes cluster. For Rancher Kubernetes Engine (RKE2) clusters, keeping an eye on certificate expiration dates helps prevent unexpected outages and ensures your applications run smoothly. In this post, we'll guide you through deploying the x509-certificate-exporter using Helm to monitor your RKE2 certificates effectively. In addition, we'll show you how to monitor the expiration of the TLS secrets that store as Kubernetes secrets which include cert-manager certificates and imported certificates.

<!--more-->
## [x509-certificate-exporter](#x509-certificate-exporter)

x509-certificate-exporter is a light and easy to install Prometheus exporter for certificates, focusing on expiration monitoring.
It can watch TLS Secrets from Kubernetes clusters, host certificate files for cluster control-plane and etcd, or run on any server with PEM files you want to get metrics for.

## [Prerequisites](#prerequisites)

- A running RKE2 cluster
- kubectl access to the cluster
- Helm v3 installed

## [Deploying x509-certificate-exporter](#deploying-x509-certificate-exporter)

First, add the Helm repository for x509-certificate-exporter:

```bash
helm repo add enix https://charts.enix.io
```

We are going create the following `values.yaml`

```yaml
exposePerCertificateErrorMetrics: true
exposeRelativeMetrics: true
grafana:
    createDashboard: false
    sidecarLabel: grafana_dashboard
    sidecarLabelValue: '1'
hostNetwork: false
hostPathsExporter:
    daemonSets:
    cp:
        nodeSelector:
        kubernetes.io/os: linux
        node-role.kubernetes.io/control-plane: 'true'
        tolerations:
        - effect: NoSchedule
            key: cattle.io/os
            operator: Equal
            value: linux
        - effect: NoExecute
            operator: Exists
        - effect: NoSchedule
            operator: Exists
        watchFiles:
        - /var/lib/rancher/rke2/server/tls/client-admin.crt
        - /var/lib/rancher/rke2/server/tls/client-auth-proxy.crt
        - /var/lib/rancher/rke2/server/tls/client-ca.crt
        - /var/lib/rancher/rke2/server/tls/client-ca.nochain.crt
        - /var/lib/rancher/rke2/server/tls/client-controller.crt
        - /var/lib/rancher/rke2/server/tls/client-kube-apiserver.crt
        - /var/lib/rancher/rke2/server/tls/client-kube-proxy.crt
        - /var/lib/rancher/rke2/server/tls/client-rke2-cloud-controller.crt
        - /var/lib/rancher/rke2/server/tls/client-rke2-controller.crt
        - /var/lib/rancher/rke2/server/tls/client-scheduler.crt
        - /var/lib/rancher/rke2/server/tls/client-supervisor.crt
        - /var/lib/rancher/rke2/server/tls/request-header-ca.crt
        - /var/lib/rancher/rke2/server/tls/server-ca.crt
        - /var/lib/rancher/rke2/server/tls/server-ca.nochain.crt
        - /var/lib/rancher/rke2/server/tls/serving-kube-apiserver.crt
        - /var/lib/rancher/rke2/server/tls/kube-controller-manager/kube-controller-manager.crt
        - /var/lib/rancher/rke2/server/tls/kube-scheduler/kube-scheduler.crt
    etcd:
        nodeSelector:
        kubernetes.io/os: linux
        node-role.kubernetes.io/etcd: 'true'
        tolerations:
        - effect: NoSchedule
            key: cattle.io/os
            operator: Equal
            value: linux
        - effect: NoExecute
            operator: Exists
        - effect: NoSchedule
            operator: Exists
        watchFiles:
        - /var/lib/rancher/rke2/server/tls/etcd/client.crt
        - /var/lib/rancher/rke2/server/tls/etcd/peer-ca.crt
        - /var/lib/rancher/rke2/server/tls/etcd/peer-server-client.crt
        - /var/lib/rancher/rke2/server/tls/etcd/server-ca.crt
        - /var/lib/rancher/rke2/server/tls/etcd/server-client.crt
    worker:
        nodeSelector:
        kubernetes.io/os: linux
        node-role.kubernetes.io/worker: 'true'
        tolerations:
        - effect: NoSchedule
            key: cattle.io/os
            operator: Equal
            value: linux
        - effect: NoExecute
            operator: Exists
        - effect: NoSchedule
            operator: Exists
        watchFiles:
        - /var/lib/rancher/rke2/agent/client-ca.crt
        - /var/lib/rancher/rke2/agent/client-kube-proxy.crt
        - /var/lib/rancher/rke2/agent/client-kubelet.crt
        - /var/lib/rancher/rke2/agent/client-rke2-controller.crt
        - /var/lib/rancher/rke2/agent/server-ca.crt
        - /var/lib/rancher/rke2/agent/serving-kubelet.crt
    debugMode: false
    hostPathVolumeType: Directory
    resources:
    limits:
        cpu: 100m
        memory: 40Mi
    requests:
        cpu: 10m
        memory: 20Mi
    restartPolicy: Always
    securityContext:
    capabilities:
        drop:
        - ALL
    readOnlyRootFilesystem: true
    runAsGroup: 0
    runAsUser: 0
prometheusPodMonitor:
    create: true
prometheusRules:
    create: true
prometheusServiceMonitor:
    create: true
secretsExporter:
    enabled: true
```

We are now going to install the chart.

```bash
helm install x509-certificate-exporter enix/x509-certificate-exporter --create-namespace --namespace rke2-cert-monitoring -f values.yaml
```

## [Accessing the metrics](#accessing-the-metrics)

The x509-certificate-exporter will be available at `http://x509-certificate-exporter.rke2-cert-monitoring.svc.cluster.local:8080/metrics`

## [Grafana Dashboard](#grafana-dashboard)

You can find the Grafana dashboard for x509-certificate-exporter [here](https://grafana.com/grafana/dashboards/13922-certificates-expiration-x509-certificate-exporter/)

NOTE: You might get an error around a missing Pie Chart plugin. You can edit the dashboard and update `grafana-piechart-panel` to use the built-in `pie` panel.

Here is an example of the dashboard:

```json
{
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": {
          "type": "datasource",
          "uid": "grafana"
        },
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Annotations & Alerts",
        "target": {
          "limit": 100,
          "matchAny": false,
          "tags": [],
          "type": "dashboard"
        },
        "type": "dashboard"
      }
    ]
  },
  "description": "Unified dashboard for checking certificates expiration: Kubernetes Secrets, certificate files on nodes, or on any server.",
  "editable": true,
  "fiscalYearStartMonth": 0,
  "gnetId": 13922,
  "graphTooltip": 0,
  "id": 97,
  "links": [],
  "liveNow": false,
  "panels": [
    {
      "collapsed": false,
      "datasource": {
        "type": "prometheus",
        "uid": "prometheus"
      },
      "gridPos": {
        "h": 1,
        "w": 24,
        "x": 0,
        "y": 0
      },
      "id": 24,
      "panels": [],
      "targets": [
        {
          "datasource": {
            "type": "prometheus",
            "uid": "prometheus"
          },
          "refId": "A"
        }
      ],
      "title": "Overview",
      "type": "row"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "super-light-blue",
                "value": null
              }
            ]
          },
          "unit": "none"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 6,
        "w": 5,
        "x": 0,
        "y": 1
      },
      "id": 2,
      "options": {
        "colorMode": "value",
        "graphMode": "area",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "text": {},
        "textMode": "value"
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "count(x509_cert_not_after)",
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Total Certificates",
      "type": "stat"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "dark-red",
                "value": 1
              }
            ]
          },
          "unit": "none"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 6,
        "w": 3,
        "x": 5,
        "y": 1
      },
      "id": 18,
      "options": {
        "colorMode": "background",
        "graphMode": "area",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "text": {},
        "textMode": "value"
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "sum(((x509_cert_not_after - time()) / 86400) < bool 0)",
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Expired",
      "type": "stat"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 1
              }
            ]
          },
          "unit": "none"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 6,
        "w": 3,
        "x": 8,
        "y": 1
      },
      "id": 19,
      "options": {
        "colorMode": "background",
        "graphMode": "area",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "text": {},
        "textMode": "value"
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "sum(0 < ((x509_cert_not_after - time()) / 86400) < bool $critical_threshold)",
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Expiring within $critical_threshold days",
      "type": "stat"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "yellow",
                "value": 1
              }
            ]
          },
          "unit": "none"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 6,
        "w": 3,
        "x": 11,
        "y": 1
      },
      "id": 20,
      "options": {
        "colorMode": "background",
        "graphMode": "area",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "text": {},
        "textMode": "value"
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "sum(0 < ((x509_cert_not_after - time()) / 86400) < bool $warning_threshold)",
          "instant": false,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Expiring within $warning_threshold days",
      "type": "stat"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "palette-classic"
          },
          "custom": {
            "hideFrom": {
              "legend": false,
              "tooltip": false,
              "viz": false
            }
          },
          "mappings": []
        },
        "overrides": []
      },
      "gridPos": {
        "h": 6,
        "w": 7,
        "x": 14,
        "y": 1
      },
      "id": 8,
      "links": [],
      "options": {
        "legend": {
          "displayMode": "list",
          "placement": "bottom",
          "showLegend": true
        },
        "pieType": "pie",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "tooltip": {
          "mode": "single",
          "sort": "none"
        }
      },
      "pluginVersion": "7.4.1",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "count(x509_cert_not_after{secret_name!=\"\"})",
          "instant": true,
          "interval": "",
          "legendFormat": "Kubernetes Secret",
          "queryType": "randomWalk",
          "refId": "A"
        },
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "count(x509_cert_not_after{filepath!=\"\",embedded_key!=\"\"})",
          "hide": false,
          "instant": true,
          "interval": "",
          "legendFormat": "Kubeconfig Embedded",
          "refId": "B"
        },
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "count(x509_cert_not_after{filepath!=\"\",embedded_key=\"\"})",
          "hide": false,
          "instant": true,
          "interval": "",
          "legendFormat": "Certificate File",
          "refId": "C"
        }
      ],
      "title": "Media",
      "type": "piechart"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "super-light-blue",
                "value": null
              }
            ]
          },
          "unit": "none"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 3,
        "w": 3,
        "x": 21,
        "y": 1
      },
      "id": 17,
      "options": {
        "colorMode": "value",
        "graphMode": "area",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "text": {},
        "textMode": "value"
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "count(x509_read_errors)",
          "instant": false,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Exporters",
      "type": "stat"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 1
              }
            ]
          },
          "unit": "none"
        },
        "overrides": []
      },
      "gridPos": {
        "h": 3,
        "w": 3,
        "x": 21,
        "y": 4
      },
      "id": 36,
      "options": {
        "colorMode": "value",
        "graphMode": "area",
        "justifyMode": "auto",
        "orientation": "auto",
        "reduceOptions": {
          "calcs": [
            "lastNotNull"
          ],
          "fields": "",
          "values": false
        },
        "text": {},
        "textMode": "value"
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "sum(x509_read_errors)",
          "instant": false,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Exporter Errors",
      "type": "stat"
    },
    {
      "collapsed": false,
      "datasource": {
        "type": "prometheus",
        "uid": "prometheus"
      },
      "gridPos": {
        "h": 1,
        "w": 24,
        "x": 0,
        "y": 7
      },
      "id": 26,
      "panels": [],
      "targets": [
        {
          "datasource": {
            "type": "prometheus",
            "uid": "prometheus"
          },
          "refId": "A"
        }
      ],
      "title": "Expiration",
      "type": "row"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "description": "Because of a missing feature in Grafana, critical and warning thresholds from dashboard variables will not affect coloration of the Time Left column in this table.\n\nThresholds are to be set manually in the Overrides settings for this widget.\n\nPlease vote or contribute to issue : https://github.com/grafana/grafana/issues/922",
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": true,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "red",
                "value": null
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Time Left"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 200
              },
              {
                "id": "custom.filterable",
                "value": false
              },
              {
                "id": "custom.displayMode",
                "value": "color-background"
              },
              {
                "id": "thresholds",
                "value": {
                  "mode": "absolute",
                  "steps": [
                    {
                      "color": "dark-red",
                      "value": null
                    },
                    {
                      "color": "red",
                      "value": 0
                    },
                    {
                      "color": "yellow",
                      "value": 7
                    },
                    {
                      "color": "green",
                      "value": 28
                    }
                  ]
                }
              },
              {
                "id": "unit",
                "value": "d"
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 13,
        "w": 12,
        "x": 0,
        "y": 8
      },
      "id": 46,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "exemplar": false,
          "expr": "sort(((x509_cert_not_after{secret_name!=\"\"} - time()) / 86400) < $list_threshold)",
          "format": "table",
          "instant": true,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Kubernetes Secrets (time left < $list_threshold days)",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "pattern": "^(subject_CN|secret_namespace|secret_name|Value)$"
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {
              "Value": 3,
              "secret_name": 2,
              "secret_namespace": 1,
              "subject_CN": 0
            },
            "renameByName": {
              "Value": "Time Left",
              "secret_name": "Secret Name",
              "secret_namespace": "Secret Namespace",
              "subject_CN": "Subject CN"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "description": "Because of a missing feature in Grafana, critical and warning thresholds from dashboard variables will not affect coloration of the Time Left column in this table.\n\nThresholds are to be set manually in the Overrides settings for this widget.\n\nPlease vote or contribute to issue : https://github.com/grafana/grafana/issues/922",
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": true,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "red",
                "value": null
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Time Left"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 200
              },
              {
                "id": "custom.filterable",
                "value": false
              },
              {
                "id": "custom.displayMode",
                "value": "color-background"
              },
              {
                "id": "thresholds",
                "value": {
                  "mode": "absolute",
                  "steps": [
                    {
                      "color": "dark-red",
                      "value": null
                    },
                    {
                      "color": "red",
                      "value": 0
                    },
                    {
                      "color": "#EAB839",
                      "value": 7
                    },
                    {
                      "color": "green",
                      "value": 28
                    }
                  ]
                }
              },
              {
                "id": "unit",
                "value": "d"
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 13,
        "w": 12,
        "x": 12,
        "y": 8
      },
      "id": 47,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "exemplar": false,
          "expr": "sort(((x509_cert_not_after{filepath!=\"\"} - time()) / 86400) < $list_threshold)",
          "format": "table",
          "instant": true,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Host Files (time left < $list_threshold days)",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "pattern": "^(subject_CN|instance|filepath|Value)$"
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {
              "Value": 3,
              "filepath": 2,
              "instance": 1,
              "subject_CN": 0
            },
            "renameByName": {
              "Value": "Time Left",
              "filepath": "File Path",
              "instance": "Instance",
              "subject_CN": "Subject CN"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "collapsed": false,
      "datasource": {
        "type": "prometheus",
        "uid": "prometheus"
      },
      "gridPos": {
        "h": 1,
        "w": 24,
        "x": 0,
        "y": 21
      },
      "id": 12,
      "panels": [],
      "targets": [
        {
          "datasource": {
            "type": "prometheus",
            "uid": "prometheus"
          },
          "refId": "A"
        }
      ],
      "title": "Charts",
      "type": "row"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Certificate Count"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 150
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 8,
        "x": 0,
        "y": 22
      },
      "id": 14,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "topk(10, sort_desc(count by (issuer_CN) (x509_cert_not_after)))",
          "format": "table",
          "instant": true,
          "interval": "",
          "intervalFactor": 1,
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Top Issuers",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "names": [
                "issuer_CN",
                "Value"
              ]
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {},
            "renameByName": {
              "Value": "Certificate Count",
              "issuer_CN": "Issuer CN"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Certificate Count"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 150
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 8,
        "x": 8,
        "y": 22
      },
      "id": 15,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "topk(10, sort_desc(count by (secret_namespace) (x509_cert_not_after{secret_namespace!=\"\"})))",
          "format": "table",
          "instant": true,
          "interval": "",
          "intervalFactor": 1,
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Top Namespaces (Kubernetes Secrets)",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "names": [
                "Value",
                "secret_namespace"
              ]
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {},
            "renameByName": {
              "Value": "Certificate Count",
              "secret_namespace": "Namespace"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Certificate Count"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 150
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 8,
        "x": 16,
        "y": 22
      },
      "id": 16,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "topk(10, sort_desc(count by (instance) (x509_cert_not_after{filepath!=\"\"})))",
          "format": "table",
          "instant": true,
          "interval": "",
          "intervalFactor": 1,
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Top Instances (Host Paths)",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "names": [
                "Value",
                "instance"
              ]
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {},
            "renameByName": {
              "Value": "Certificate Count",
              "instance": "Instance"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Days"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 100
              }
            ]
          },
          {
            "matcher": {
              "id": "byName",
              "options": "Secret Namespace"
            },
            "properties": [
              {
                "id": "custom.width",
                "value": 258
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 12,
        "x": 0,
        "y": 34
      },
      "id": 31,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true,
        "sortBy": []
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "bottomk(10, (x509_cert_not_after{secret_name!=\"\"} - x509_cert_not_before) / 86400)",
          "format": "table",
          "instant": true,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Kubernetes Secrets : Shortest Validity Period",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "pattern": "^(subject_CN|secret_namespace|secret_name|Value)$"
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {
              "Value": 3,
              "secret_name": 2,
              "secret_namespace": 1,
              "subject_CN": 0
            },
            "renameByName": {
              "Value": "Days",
              "secret_name": "Secret Name",
              "secret_namespace": "Secret Namespace",
              "subject_CN": "Subject CN"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Days"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 100
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 12,
        "x": 12,
        "y": 34
      },
      "id": 33,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "bottomk(10, (x509_cert_not_after{filepath!=\"\"} - x509_cert_not_before) / 86400)",
          "format": "table",
          "instant": true,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Host Paths : Shortest Validity Period",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "pattern": "^(subject_CN|instance|filepath|Value)$"
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {
              "Value": 3,
              "filepath": 2,
              "instance": 1,
              "subject_CN": 0
            },
            "renameByName": {
              "Value": "Days",
              "filepath": "File Path",
              "instance": "Instance",
              "subject_CN": "Subject CN"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Days"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 100
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 12,
        "x": 0,
        "y": 46
      },
      "id": 28,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "topk(10, (x509_cert_not_after{secret_name!=\"\"} - x509_cert_not_before) / 86400)",
          "format": "table",
          "instant": true,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Kubernetes Secrets : Longest Validity Period",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "pattern": "^(subject_CN|secret_namespace|secret_name|Value)$"
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {
              "Value": 3,
              "secret_name": 2,
              "secret_namespace": 1,
              "subject_CN": 0
            },
            "renameByName": {
              "Value": "Days",
              "secret_name": "Secret Name",
              "secret_namespace": "Secret Namespace",
              "subject_CN": "Subject CN"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Days"
            },
            "properties": [
              {
                "id": "custom.align",
                "value": "center"
              },
              {
                "id": "custom.width",
                "value": 100
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 12,
        "x": 12,
        "y": 46
      },
      "id": 32,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "topk(10, (x509_cert_not_after{filepath!=\"\"} - x509_cert_not_before) / 86400)",
          "format": "table",
          "instant": true,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Host Paths : Longest Validity Period",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "pattern": "^(subject_CN|instance|filepath|Value)$"
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {
              "Value": 3,
              "filepath": 2,
              "instance": 1,
              "subject_CN": 0
            },
            "renameByName": {
              "Value": "Days",
              "filepath": "File Path",
              "instance": "Instance",
              "subject_CN": "Subject CN"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "collapsed": false,
      "datasource": {
        "type": "prometheus",
        "uid": "prometheus"
      },
      "gridPos": {
        "h": 1,
        "w": 24,
        "x": 0,
        "y": 58
      },
      "id": 35,
      "panels": [],
      "targets": [
        {
          "datasource": {
            "type": "prometheus",
            "uid": "prometheus"
          },
          "refId": "A"
        }
      ],
      "title": "Exporters",
      "type": "row"
    },
    {
      "aliasColors": {},
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 59
      },
      "hiddenSeries": false,
      "id": 38,
      "legend": {
        "alignAsTable": true,
        "avg": false,
        "current": true,
        "max": true,
        "min": true,
        "rightSide": false,
        "show": true,
        "total": false,
        "values": true
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "9.1.5",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "count(x509_read_errors)",
          "interval": "",
          "legendFormat": "exporters",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeRegions": [],
      "title": "Reporting Exporters",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "mode": "time",
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "$$hashKey": "object:237",
          "format": "short",
          "logBase": 1,
          "show": true
        },
        {
          "$$hashKey": "object:238",
          "format": "short",
          "logBase": 1,
          "show": true
        }
      ],
      "yaxis": {
        "align": false
      }
    },
    {
      "aliasColors": {
        "exporters with errors": "red"
      },
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 59
      },
      "hiddenSeries": false,
      "id": 39,
      "legend": {
        "alignAsTable": true,
        "avg": false,
        "current": true,
        "max": true,
        "min": true,
        "rightSide": false,
        "show": true,
        "total": false,
        "values": true
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "9.1.5",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "sum (x509_read_errors > bool 0)",
          "interval": "",
          "legendFormat": "exporters with errors",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeRegions": [],
      "title": "Exporters with Errors",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "mode": "time",
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "$$hashKey": "object:237",
          "format": "short",
          "logBase": 1,
          "show": true
        },
        {
          "$$hashKey": "object:238",
          "format": "short",
          "logBase": 1,
          "show": true
        }
      ],
      "yaxis": {
        "align": false
      }
    },
    {
      "aliasColors": {
        "error rate": "red",
        "errors": "red"
      },
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 67
      },
      "hiddenSeries": false,
      "id": 41,
      "legend": {
        "alignAsTable": true,
        "avg": false,
        "current": true,
        "max": true,
        "min": true,
        "rightSide": false,
        "show": true,
        "total": false,
        "values": true
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "9.1.5",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "sum(rate(x509_read_errors[15m]))",
          "interval": "",
          "legendFormat": "error rate",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeRegions": [],
      "title": "Error Rate",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "mode": "time",
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "$$hashKey": "object:237",
          "format": "cps",
          "logBase": 1,
          "show": true
        },
        {
          "$$hashKey": "object:238",
          "format": "short",
          "logBase": 1,
          "show": true
        }
      ],
      "yaxis": {
        "align": false
      }
    },
    {
      "aliasColors": {
        "errors": "red"
      },
      "bars": false,
      "dashLength": 10,
      "dashes": false,
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fill": 1,
      "fillGradient": 0,
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 67
      },
      "hiddenSeries": false,
      "id": 40,
      "legend": {
        "alignAsTable": true,
        "avg": false,
        "current": true,
        "max": true,
        "min": true,
        "rightSide": false,
        "show": true,
        "total": false,
        "values": true
      },
      "lines": true,
      "linewidth": 1,
      "nullPointMode": "null",
      "options": {
        "alertThreshold": true
      },
      "percentage": false,
      "pluginVersion": "9.1.5",
      "pointradius": 2,
      "points": false,
      "renderer": "flot",
      "seriesOverrides": [],
      "spaceLength": 10,
      "stack": false,
      "steppedLine": false,
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "sum(x509_read_errors)",
          "interval": "",
          "legendFormat": "errors",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "thresholds": [],
      "timeRegions": [],
      "title": "Cumulative Errors",
      "tooltip": {
        "shared": true,
        "sort": 0,
        "value_type": "individual"
      },
      "type": "graph",
      "xaxis": {
        "mode": "time",
        "show": true,
        "values": []
      },
      "yaxes": [
        {
          "$$hashKey": "object:237",
          "format": "short",
          "logBase": 1,
          "show": true
        },
        {
          "$$hashKey": "object:238",
          "format": "short",
          "logBase": 1,
          "show": true
        }
      ],
      "yaxis": {
        "align": false
      }
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Rate"
            },
            "properties": [
              {
                "id": "custom.width",
                "value": 150
              },
              {
                "id": "custom.align",
                "value": "center"
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 12,
        "x": 0,
        "y": 75
      },
      "id": 43,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "topk(10, rate(x509_read_errors[6h]))",
          "format": "table",
          "instant": true,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Top Exporters by Error Rate",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "pattern": "^(instance|Value)$"
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {},
            "renameByName": {
              "Value": "Rate",
              "instance": "Instance"
            }
          }
        }
      ],
      "type": "table"
    },
    {
      "datasource": {
        "uid": "${DS_PROMETHEUS}"
      },
      "fieldConfig": {
        "defaults": {
          "color": {
            "mode": "thresholds"
          },
          "custom": {
            "displayMode": "auto",
            "filterable": false,
            "inspect": false
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 80
              }
            ]
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "Errors"
            },
            "properties": [
              {
                "id": "custom.width",
                "value": 150
              },
              {
                "id": "custom.align",
                "value": "center"
              }
            ]
          }
        ]
      },
      "gridPos": {
        "h": 12,
        "w": 12,
        "x": 12,
        "y": 75
      },
      "id": 44,
      "options": {
        "footer": {
          "fields": "",
          "reducer": [
            "sum"
          ],
          "show": false
        },
        "showHeader": true
      },
      "pluginVersion": "9.1.5",
      "targets": [
        {
          "datasource": {
            "uid": "${DS_PROMETHEUS}"
          },
          "expr": "topk(10, x509_read_errors)",
          "format": "table",
          "instant": true,
          "interval": "",
          "legendFormat": "",
          "queryType": "randomWalk",
          "refId": "A"
        }
      ],
      "title": "Top Exporters by Cumulative Errors",
      "transformations": [
        {
          "id": "filterFieldsByName",
          "options": {
            "include": {
              "pattern": "^(instance|Value)$"
            }
          }
        },
        {
          "id": "organize",
          "options": {
            "excludeByName": {},
            "indexByName": {},
            "renameByName": {
              "Value": "Errors",
              "instance": "Instance"
            }
          }
        }
      ],
      "type": "table"
    }
  ],
  "refresh": false,
  "schemaVersion": 37,
  "style": "dark",
  "tags": [],
  "templating": {
    "list": [
      {
        "current": {
          "selected": false,
          "text": "Prometheus",
          "value": "Prometheus"
        },
        "hide": 0,
        "includeAll": false,
        "label": "Datasource",
        "multi": false,
        "name": "DS_PROMETHEUS",
        "options": [],
        "query": "prometheus",
        "queryValue": "",
        "refresh": 1,
        "regex": "",
        "skipUrlSync": false,
        "type": "datasource"
      },
      {
        "current": {
          "selected": true,
          "text": "7",
          "value": "7"
        },
        "hide": 0,
        "includeAll": false,
        "label": "Critical Threshold (days)",
        "multi": false,
        "name": "critical_threshold",
        "options": [
          {
            "selected": false,
            "text": "1",
            "value": "1"
          },
          {
            "selected": true,
            "text": "7",
            "value": "7"
          },
          {
            "selected": false,
            "text": "14",
            "value": "14"
          },
          {
            "selected": false,
            "text": "15",
            "value": "15"
          },
          {
            "selected": false,
            "text": "28",
            "value": "28"
          },
          {
            "selected": false,
            "text": "30",
            "value": "30"
          },
          {
            "selected": false,
            "text": "60",
            "value": "60"
          },
          {
            "selected": false,
            "text": "90",
            "value": "90"
          },
          {
            "selected": false,
            "text": "180",
            "value": "180"
          },
          {
            "selected": false,
            "text": "365",
            "value": "365"
          }
        ],
        "query": "1,7,14,15,28,30,60,90,180,365",
        "queryValue": "",
        "skipUrlSync": false,
        "type": "custom"
      },
      {
        "current": {
          "selected": true,
          "text": "28",
          "value": "28"
        },
        "hide": 0,
        "includeAll": false,
        "label": "Warning Threshold (days)",
        "multi": false,
        "name": "warning_threshold",
        "options": [
          {
            "selected": false,
            "text": "1",
            "value": "1"
          },
          {
            "selected": false,
            "text": "7",
            "value": "7"
          },
          {
            "selected": false,
            "text": "14",
            "value": "14"
          },
          {
            "selected": false,
            "text": "15",
            "value": "15"
          },
          {
            "selected": true,
            "text": "28",
            "value": "28"
          },
          {
            "selected": false,
            "text": "30",
            "value": "30"
          },
          {
            "selected": false,
            "text": "60",
            "value": "60"
          },
          {
            "selected": false,
            "text": "90",
            "value": "90"
          },
          {
            "selected": false,
            "text": "180",
            "value": "180"
          },
          {
            "selected": false,
            "text": "365",
            "value": "365"
          }
        ],
        "query": "1,7,14,15,28,30,60,90,180,365",
        "queryValue": "",
        "skipUrlSync": false,
        "type": "custom"
      },
      {
        "current": {
          "selected": true,
          "text": "180",
          "value": "180"
        },
        "hide": 0,
        "includeAll": false,
        "label": "List expiring in less than (days)",
        "multi": false,
        "name": "list_threshold",
        "options": [
          {
            "selected": false,
            "text": "1",
            "value": "1"
          },
          {
            "selected": false,
            "text": "7",
            "value": "7"
          },
          {
            "selected": false,
            "text": "15",
            "value": "15"
          },
          {
            "selected": false,
            "text": "30",
            "value": "30"
          },
          {
            "selected": false,
            "text": "60",
            "value": "60"
          },
          {
            "selected": false,
            "text": "90",
            "value": "90"
          },
          {
            "selected": true,
            "text": "180",
            "value": "180"
          },
          {
            "selected": false,
            "text": "365",
            "value": "365"
          },
          {
            "selected": false,
            "text": "730",
            "value": "730"
          },
          {
            "selected": false,
            "text": "1095",
            "value": "1095"
          },
          {
            "selected": false,
            "text": "1460",
            "value": "1460"
          },
          {
            "selected": false,
            "text": "1825",
            "value": "1825"
          },
          {
            "selected": false,
            "text": "3650",
            "value": "3650"
          },
          {
            "selected": false,
            "text": "7300",
            "value": "7300"
          }
        ],
        "query": "1,7,15,30,60,90,180,365,730,1095,1460,1825,3650,7300",
        "queryValue": "",
        "skipUrlSync": false,
        "type": "custom"
      }
    ]
  },
  "time": {
    "from": "now-6h",
    "to": "now"
  },
  "timepicker": {},
  "timezone": "",
  "title": "Certificates Expiration (X509 Certificate Exporter)",
  "uid": "lHnsYlPGk",
  "version": 1,
  "weekStart": ""
}
```

## [Conclusion](#conclusion)

Deploying the x509-certificate-exporter in your RKE2 cluster offers peace of mind by ensuring you're always aware of the state of your certificates. By integrating this with Prometheus and Grafana, you can set up alerts to notify you well before any certificates expire, keeping your applications secure and running without interruption.

For more advanced configurations and usage, refer to the [x509-certificate-exporter GitHub repository](https://github.com/enix/x509-certificate-exporter).

Happy monitoring!
