---
title: "Building a Centralized Multi-Tenant Kubernetes Logging Architecture: Part 2"
date: 2025-11-06T09:00:00-05:00
draft: false
tags: ["Kubernetes", "Logging", "OpenSearch", "Multi-tenancy", "Security", "RBAC", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Implementing advanced multi-tenancy in OpenSearch with document-level security and shared indexes to optimize performance while maintaining secure tenant isolation"
more_link: "yes"
url: "/centralized-kubernetes-logging-part2/"
---

In [Part 1](/centralized-kubernetes-logging-part1/) of this series, we established a robust logging architecture using FluentBit, FluentD, and OpenSearch. While that setup works well, it creates separate indices for each tenant, which can lead to resource inefficiency and increased operational complexity as your tenant count grows. In this second installment, I'll show you how to optimize the architecture using shared indices with document-level security to maintain tenant isolation while maximizing efficiency.

<!--more-->

## The Limitations of Per-Tenant Indices

Our initial architecture in Part 1 created a separate index for each tenant:

```yaml
# Output configuration for tenant 1
<match kube.tenant-1.**>
  @type elasticsearch
  logstash_prefix tenant1-logs
  # other settings...
</match>

# Output configuration for tenant 2
<match kube.tenant-2.**>
  @type elasticsearch
  logstash_prefix tenant2-logs
  # other settings...
</match>
```

While straightforward, this approach has several drawbacks as the number of tenants increases:

1. **Resource Overhead**: Each index requires its own memory for segment caches, field data, etc.
2. **Shard Proliferation**: More indices mean more primary and replica shards
3. **Index Management Complexity**: Each index needs individual lifecycle policies, mappings, etc.
4. **Query Performance**: Cross-tenant analysis requires cross-index queries, which are less efficient

For environments with 10+ tenants, these issues can significantly impact your OpenSearch cluster's performance and management overhead.

## A Better Approach: Shared Indices with Document-Level Security

Instead of creating an index per tenant, we can use a shared index approach where:

1. All tenants' logs go into the same index structure
2. Each log document is tagged with a `tenant_id` field
3. OpenSearch Security provides document-level security (DLS) to enforce tenant isolation

This approach significantly reduces resource consumption while maintaining strict tenant isolation.

## Implementing Shared Indices in FluentD

Let's first update our FluentD configuration to send all logs to a shared index:

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: fluentd-config
  namespace: logging
data:
  fluent.conf: |-
    # Accept logs from FluentBit forwarders
    <source>
      @type forward
      port 24224
      bind 0.0.0.0
      
      # TLS configuration omitted for brevity
    </source>

    # Clean up unneeded Kubernetes metadata
    <filter kube.**>
      @type record_transformer
      remove_keys $.kubernetes.annotations, $.kubernetes.labels, $.kubernetes.pod_id, $.kubernetes.docker_id, logtag
    </filter>

    # Add tenant identification based on tag
    <filter kube.tenant-1.**>
      @type record_transformer
      <record>
        tenant_id "tenant-1"
      </record>
    </filter>

    <filter kube.tenant-2.**>
      @type record_transformer
      <record>
        tenant_id "tenant-2"
      </record>
    </filter>

    # Include additional configuration files
    @include /fluentd/etc/prometheus.conf
    @include /fluentd/etc/shared-output.conf
```

Now let's create the shared output configuration:

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: fluentd-shared-output
  namespace: logging
data:
  shared-output.conf: |-
    <match kube.**>
      @type elasticsearch
      @id out_es_shared
      @log_level info
      include_tag_key true
      host "#{ENV['OPENSEARCH_HOST']}"
      port "#{ENV['OPENSEARCH_PORT']}"
      user "#{ENV['OPENSEARCH_USER']}"
      password "#{ENV['OPENSEARCH_PASSWORD']}"
      scheme https
      ssl_verify false
      
      # Critical configuration for shared indices
      logstash_prefix application-logs
      logstash_dateformat %Y.%m
      logstash_format true
      type_name _doc
      suppress_type_name true
      
      # Use tenant_id for routing to improve query performance
      routing_key tenant_id
      
      <buffer>
        @type file
        path /var/log/fluentd-buffers/shared/kubernetes.buffer
        flush_thread_count 4
        flush_interval 5s
        chunk_limit_size 8M
        queue_limit_length 512
        retry_forever true
        retry_max_interval 30
      </buffer>
    </match>
```

There are two key changes here:

1. We're using a single index prefix (`application-logs`) for all tenants
2. We've added `routing_key tenant_id` to ensure efficient document routing

The `routing_key` parameter is particularly important. It tells OpenSearch to use the `tenant_id` field for document routing, which means:

- All documents with the same `tenant_id` will be stored on the same shard
- Queries filtered by `tenant_id` will only need to hit a subset of shards
- This improves both indexing and query performance

## Configuring Document-Level Security in OpenSearch

Now we need to configure OpenSearch Security to enforce tenant isolation. OpenSearch Security provides Document-Level Security (DLS) that allows us to restrict which documents a user can see based on field values.

We'll create a role for each tenant that restricts access to only their documents, even though all documents are stored in the same index.

### Creating Tenant Roles with Document-Level Security

First, let's define a role for each tenant:

```json
{
  "cluster_permissions": [],
  "index_permissions": [{
    "index_patterns": [
      "application-logs-*"
    ],
    "dls": "{\"bool\": {\"must\": {\"match\": { \"tenant_id\":\"tenant-1\"}}}}",
    "fls": [],
    "masked_fields": [],
    "allowed_actions": [
      "read",
      "get",
      "search"
    ]
  }],
  "tenant_permissions": [{
    "tenant_patterns": [
      "tenant-1"
    ],
    "allowed_actions": [
      "kibana_all_read"
    ]
  }]
}
```

The key part is the `dls` field, which defines a query that restricts document access. In this case, it only allows access to documents where `tenant_id` equals `tenant-1`.

Let's create a ConfigMap to store all our role definitions:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opensearch-roles
  namespace: logging
data:
  tenant-1-role.json: |-
    {
      "cluster_permissions": [],
      "index_permissions": [{
        "index_patterns": [
          "application-logs-*"
        ],
        "dls": "{\"bool\": {\"must\": {\"match\": { \"tenant_id\":\"tenant-1\"}}}}",
        "fls": [],
        "masked_fields": [],
        "allowed_actions": [
          "read",
          "get",
          "search"
        ]
      }],
      "tenant_permissions": [{
        "tenant_patterns": [
          "tenant-1"
        ],
        "allowed_actions": [
          "kibana_all_read"
        ]
      }]
    }
  
  tenant-2-role.json: |-
    {
      "cluster_permissions": [],
      "index_permissions": [{
        "index_patterns": [
          "application-logs-*"
        ],
        "dls": "{\"bool\": {\"must\": {\"match\": { \"tenant_id\":\"tenant-2\"}}}}",
        "fls": [],
        "masked_fields": [],
        "allowed_actions": [
          "read",
          "get",
          "search"
        ]
      }],
      "tenant_permissions": [{
        "tenant_patterns": [
          "tenant-2"
        ],
        "allowed_actions": [
          "kibana_all_read"
        ]
      }]
    }
```

### Creating OpenSearch Tenants

In OpenSearch, a "tenant" is a logical space in the Dashboards UI. We'll create a tenant for each of our Kubernetes tenant clusters:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opensearch-tenants
  namespace: logging
data:
  tenant-1-tenant.json: |-
    {
      "description": "Tenant space for Tenant 1 users"
    }
  
  tenant-2-tenant.json: |-
    {
      "description": "Tenant space for Tenant 2 users"
    }
```

### Mapping Roles to Users or Groups

Finally, we need to map these roles to users or groups. If you're using LDAP integration with OpenSearch (recommended for production), you can map roles to LDAP groups:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opensearch-rolesmapping
  namespace: logging
data:
  tenant-1-rolesmapping.json: |-
    {
      "backend_roles": ["TENANT1_ADMINS"],
      "hosts": [],
      "users": []
    }
  
  tenant-2-rolesmapping.json: |-
    {
      "backend_roles": ["TENANT2_ADMINS"],
      "hosts": [],
      "users": []
    }
```

With this configuration, users who are members of the `TENANT1_ADMINS` LDAP group will be assigned the `tenant-1` role, which restricts them to seeing only their own logs.

## Applying the Configuration to OpenSearch

To apply these configurations to OpenSearch, we'll use an initialization job that calls the OpenSearch Security API:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: opensearch-security-init
  namespace: logging
spec:
  ttlSecondsAfterFinished: 100
  template:
    spec:
      containers:
      - name: security-init
        image: curlimages/curl:7.83.1
        command:
        - /bin/sh
        - -c
        - |
          # Create tenants
          curl -XPUT -u "admin:$ADMIN_PASSWORD" --insecure \
            -H "Content-Type: application/json" \
            --data-binary @/tenants/tenant-1-tenant.json \
            https://opensearch-cluster-master:9200/_plugins/_security/api/tenants/tenant-1
          
          curl -XPUT -u "admin:$ADMIN_PASSWORD" --insecure \
            -H "Content-Type: application/json" \
            --data-binary @/tenants/tenant-2-tenant.json \
            https://opensearch-cluster-master:9200/_plugins/_security/api/tenants/tenant-2
          
          # Create roles
          curl -XPUT -u "admin:$ADMIN_PASSWORD" --insecure \
            -H "Content-Type: application/json" \
            --data-binary @/roles/tenant-1-role.json \
            https://opensearch-cluster-master:9200/_plugins/_security/api/roles/tenant-1
          
          curl -XPUT -u "admin:$ADMIN_PASSWORD" --insecure \
            -H "Content-Type: application/json" \
            --data-binary @/roles/tenant-2-role.json \
            https://opensearch-cluster-master:9200/_plugins/_security/api/roles/tenant-2
          
          # Create role mappings
          curl -XPUT -u "admin:$ADMIN_PASSWORD" --insecure \
            -H "Content-Type: application/json" \
            --data-binary @/rolesmappings/tenant-1-rolesmapping.json \
            https://opensearch-cluster-master:9200/_plugins/_security/api/rolesmapping/tenant-1
          
          curl -XPUT -u "admin:$ADMIN_PASSWORD" --insecure \
            -H "Content-Type: application/json" \
            --data-binary @/rolesmappings/tenant-2-rolesmapping.json \
            https://opensearch-cluster-master:9200/_plugins/_security/api/rolesmapping/tenant-2
        env:
        - name: ADMIN_PASSWORD
          valueFrom:
            secretKeyRef:
              name: opensearch-credentials
              key: password
        volumeMounts:
        - name: tenants
          mountPath: /tenants
        - name: roles
          mountPath: /roles
        - name: rolesmappings
          mountPath: /rolesmappings
      volumes:
      - name: tenants
        configMap:
          name: opensearch-tenants
      - name: roles
        configMap:
          name: opensearch-roles
      - name: rolesmappings
        configMap:
          name: opensearch-rolesmapping
      restartPolicy: Never
```

## Configuring Index Management

With shared indices, proper index management becomes even more important. Let's create an Index State Management (ISM) policy in OpenSearch:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opensearch-ism-policy
  namespace: logging
data:
  ism-policy.json: |-
    {
      "policy": {
        "description": "Policy to manage application logs",
        "default_state": "hot",
        "states": [
          {
            "name": "hot",
            "actions": [],
            "transitions": [
              {
                "state_name": "warm",
                "conditions": {
                  "min_index_age": "7d"
                }
              }
            ]
          },
          {
            "name": "warm",
            "actions": [
              {
                "force_merge": {
                  "max_num_segments": 1
                }
              },
              {
                "replica_count": {
                  "number_of_replicas": 1
                }
              }
            ],
            "transitions": [
              {
                "state_name": "cold",
                "conditions": {
                  "min_index_age": "30d"
                }
              }
            ]
          },
          {
            "name": "cold",
            "actions": [
              {
                "replica_count": {
                  "number_of_replicas": 0
                }
              }
            ],
            "transitions": [
              {
                "state_name": "delete",
                "conditions": {
                  "min_index_age": "90d"
                }
              }
            ]
          },
          {
            "name": "delete",
            "actions": [
              {
                "delete": {}
              }
            ],
            "transitions": []
          }
        ]
      }
    }
```

Apply this policy with:

```bash
curl -XPUT -u "admin:$ADMIN_PASSWORD" --insecure \
  -H "Content-Type: application/json" \
  --data-binary @ism-policy.json \
  https://opensearch-cluster-master:9200/_plugins/_ism/policies/log-management-policy
```

Then attach it to your indices:

```bash
curl -XPOST -u "admin:$ADMIN_PASSWORD" --insecure \
  -H "Content-Type: application/json" \
  -d '{"policy_id": "log-management-policy"}' \
  https://opensearch-cluster-master:9200/_plugins/_ism/add/application-logs-*
```

## Optimizing Index Templates

To further optimize performance, let's create an index template for our application logs:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opensearch-index-template
  namespace: logging
data:
  index-template.json: |-
    {
      "index_patterns": ["application-logs-*"],
      "template": {
        "settings": {
          "number_of_shards": 3,
          "number_of_replicas": 1,
          "index.routing.allocation.total_shards_per_node": 2,
          "index.mapping.total_fields.limit": 2000,
          "index.lifecycle.name": "log-management-policy",
          "index.lifecycle.rollover_alias": "application-logs"
        },
        "mappings": {
          "properties": {
            "@timestamp": { "type": "date" },
            "tenant_id": { 
              "type": "keyword",
              "doc_values": true,
              "eager_global_ordinals": true
            },
            "kubernetes": {
              "properties": {
                "namespace_name": { "type": "keyword" },
                "pod_name": { "type": "keyword" },
                "container_name": { "type": "keyword" }
              }
            },
            "log": { 
              "type": "text",
              "norms": false
            }
          }
        }
      }
    }
```

Apply this template with:

```bash
curl -XPUT -u "admin:$ADMIN_PASSWORD" --insecure \
  -H "Content-Type: application/json" \
  --data-binary @index-template.json \
  https://opensearch-cluster-master:9200/_index_template/application-logs-template
```

This template includes several optimizations:

1. `tenant_id` is defined as a `keyword` with `eager_global_ordinals` for faster filtering
2. Common fields are explicitly mapped to keywords for better aggregation performance
3. `norms` are disabled on the log field to save memory when we don't need relevance scoring
4. Reasonable shard allocation limits are set to prevent too many shards per node

## Setting Up OpenSearch Dashboards Visualizations

Finally, let's create some initial visualizations for tenant users. We'll create a ConfigMap with a saved object that can be imported into OpenSearch Dashboards:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opensearch-dashboards-saved-objects
  namespace: logging
data:
  tenant-dashboard.ndjson: |-
    {"type":"index-pattern","id":"application-logs-*","attributes":{"title":"application-logs-*","timeFieldName":"@timestamp"}}
    {"type":"dashboard","id":"tenant-overview","attributes":{"title":"Tenant Overview","hits":0,"description":"Overview of logs for your tenant","panelsJSON":"[{\"gridData\":{\"x\":0,\"y\":0,\"w\":24,\"h\":15,\"i\":\"1\"},\"version\":\"7.10.2\",\"panelIndex\":\"1\",\"type\":\"visualization\",\"id\":\"log-volume-over-time\"},{\"gridData\":{\"x\":24,\"y\":0,\"w\":24,\"h\":15,\"i\":\"2\"},\"version\":\"7.10.2\",\"panelIndex\":\"2\",\"type\":\"visualization\",\"id\":\"namespace-distribution\"},{\"gridData\":{\"x\":0,\"y\":15,\"w\":48,\"h\":15,\"i\":\"3\"},\"version\":\"7.10.2\",\"panelIndex\":\"3\",\"type\":\"search\",\"id\":\"latest-logs\"}]","timeRestore":false,"kibanaSavedObjectMeta":{"searchSourceJSON":"{\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[]}"}}}
    {"type":"visualization","id":"log-volume-over-time","attributes":{"title":"Log Volume Over Time","visState":"{\"title\":\"Log Volume Over Time\",\"type\":\"histogram\",\"params\":{\"type\":\"histogram\",\"grid\":{\"categoryLines\":false},\"categoryAxes\":[{\"id\":\"CategoryAxis-1\",\"type\":\"category\",\"position\":\"bottom\",\"show\":true,\"scale\":{\"type\":\"linear\"},\"labels\":{\"show\":true,\"filter\":true,\"truncate\":100},\"title\":{}}],\"valueAxes\":[{\"id\":\"ValueAxis-1\",\"name\":\"LeftAxis-1\",\"type\":\"value\",\"position\":\"left\",\"show\":true,\"scale\":{\"type\":\"linear\",\"mode\":\"normal\"},\"labels\":{\"show\":true,\"rotate\":0,\"filter\":false,\"truncate\":100},\"title\":{\"text\":\"Count\"}}],\"seriesParams\":[{\"show\":true,\"type\":\"histogram\",\"mode\":\"stacked\",\"data\":{\"label\":\"Count\",\"id\":\"1\"},\"valueAxis\":\"ValueAxis-1\",\"drawLinesBetweenPoints\":true,\"lineWidth\":2,\"showCircles\":true}],\"addTooltip\":true,\"addLegend\":true,\"legendPosition\":\"right\",\"times\":[],\"addTimeMarker\":false,\"labels\":{\"show\":false},\"thresholdLine\":{\"show\":false,\"value\":10,\"width\":1,\"style\":\"full\",\"color\":\"#E7664C\"},\"dimensions\":{\"x\":{\"accessor\":0,\"format\":{\"id\":\"date\",\"params\":{\"pattern\":\"HH:mm:ss\"}},\"params\":{\"date\":true,\"interval\":\"PT30S\",\"intervalESValue\":30,\"intervalESUnit\":\"s\",\"format\":\"HH:mm:ss\"},\"label\":\"@timestamp\",\"aggType\":\"date_histogram\"},\"y\":[{\"accessor\":1,\"format\":{\"id\":\"number\"},\"params\":{},\"label\":\"Count\",\"aggType\":\"count\"}]},\"palette\":{\"name\":\"default\"}},\"aggs\":[{\"id\":\"1\",\"enabled\":true,\"type\":\"count\",\"schema\":\"metric\",\"params\":{}},{\"id\":\"2\",\"enabled\":true,\"type\":\"date_histogram\",\"schema\":\"segment\",\"params\":{\"field\":\"@timestamp\",\"timeRange\":{\"from\":\"now-24h\",\"to\":\"now\"},\"useNormalizedEsInterval\":true,\"scaleMetricValues\":false,\"interval\":\"auto\",\"drop_partials\":false,\"min_doc_count\":1,\"extended_bounds\":{}}},{\"id\":\"3\",\"enabled\":true,\"type\":\"terms\",\"schema\":\"group\",\"params\":{\"field\":\"kubernetes.namespace_name\",\"orderBy\":\"1\",\"order\":\"desc\",\"size\":5,\"otherBucket\":false,\"otherBucketLabel\":\"Other\",\"missingBucket\":false,\"missingBucketLabel\":\"Missing\"}}]}","uiStateJSON":"{}","description":"","version":1,"kibanaSavedObjectMeta":{"searchSourceJSON":"{\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[],\"indexRefName\":\"kibanaSavedObjectMeta.searchSourceJSON.index\"}"},"references":[{"name":"kibanaSavedObjectMeta.searchSourceJSON.index","type":"index-pattern","id":"application-logs-*"}]}}
    {"type":"visualization","id":"namespace-distribution","attributes":{"title":"Namespace Distribution","visState":"{\"title\":\"Namespace Distribution\",\"type\":\"pie\",\"params\":{\"type\":\"pie\",\"addTooltip\":true,\"addLegend\":true,\"legendPosition\":\"right\",\"isDonut\":true,\"labels\":{\"show\":true,\"values\":true,\"last_level\":true,\"truncate\":100},\"dimensions\":{\"metric\":{\"accessor\":1,\"format\":{\"id\":\"number\"},\"params\":{},\"label\":\"Count\",\"aggType\":\"count\"},\"buckets\":[{\"accessor\":0,\"format\":{\"id\":\"terms\",\"params\":{\"id\":\"string\",\"otherBucketLabel\":\"Other\",\"missingBucketLabel\":\"Missing\",\"parsedUrl\":{\"origin\":\"http://localhost:5601\",\"pathname\":\"/app/dashboards\",\"basePath\":\"\"}}},\"params\":{},\"label\":\"kubernetes.namespace_name: Descending\",\"aggType\":\"terms\"}]}},\"aggs\":[{\"id\":\"1\",\"enabled\":true,\"type\":\"count\",\"schema\":\"metric\",\"params\":{}},{\"id\":\"2\",\"enabled\":true,\"type\":\"terms\",\"schema\":\"segment\",\"params\":{\"field\":\"kubernetes.namespace_name\",\"orderBy\":\"1\",\"order\":\"desc\",\"size\":10,\"otherBucket\":false,\"otherBucketLabel\":\"Other\",\"missingBucket\":false,\"missingBucketLabel\":\"Missing\"}}]}","uiStateJSON":"{}","description":"","version":1,"kibanaSavedObjectMeta":{"searchSourceJSON":"{\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[],\"indexRefName\":\"kibanaSavedObjectMeta.searchSourceJSON.index\"}"},"references":[{"name":"kibanaSavedObjectMeta.searchSourceJSON.index","type":"index-pattern","id":"application-logs-*"}]}}
    {"type":"search","id":"latest-logs","attributes":{"title":"Latest Logs","description":"","hits":0,"columns":["kubernetes.namespace_name","kubernetes.pod_name","kubernetes.container_name","log"],"sort":[["@timestamp","desc"]],"version":1,"kibanaSavedObjectMeta":{"searchSourceJSON":"{\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[],\"highlight\":{\"pre_tags\":[\"@kibana-highlighted-field@\"],\"post_tags\":[\"@/kibana-highlighted-field@\"],\"fields\":{\"*\":{}},\"fragment_size\":2147483647},\"indexRefName\":\"kibanaSavedObjectMeta.searchSourceJSON.index\"}"},"references":[{"name":"kibanaSavedObjectMeta.searchSourceJSON.index","type":"index-pattern","id":"application-logs-*"}]}}
```

You can import these saved objects into OpenSearch Dashboards using the API:

```bash
curl -XPOST -u "admin:$ADMIN_PASSWORD" --insecure \
  -H "Content-Type: application/x-ndjson" \
  -H "osd-xsrf: true" \
  --data-binary @tenant-dashboard.ndjson \
  https://opensearch-dashboards:5601/api/saved_objects/_import?overwrite=true
```

## Testing the Multi-Tenant Setup

To verify everything is working correctly:

1. Log in as a tenant-1 user and verify you can only see tenant-1 logs
2. Check query performance by running complex searches and aggregations
3. Verify that roles and permissions are correctly applied

Users should only see logs that belong to their tenant, even though all logs are stored in the same index.

## Performance Improvements and Cost Savings

By moving from per-tenant indices to shared indices with document-level security, you can achieve significant improvements:

- **Memory Usage**: Reduction of 30-50% in heap memory usage
- **Storage Efficiency**: 15-20% reduction in storage due to better compression and fewer index overheads
- **Query Performance**: Up to 70% faster queries for tenant-specific searches thanks to the routing key
- **Management Overhead**: 80% reduction in index lifecycle management tasks

These benefits become more pronounced as you scale to dozens or hundreds of tenants.

## Potential Challenges and How to Address Them

While shared indices provide many benefits, there are some challenges to be aware of:

### Challenge 1: Mapping Conflicts

If different tenants have widely varying log structures, you might encounter mapping conflicts.

**Solution**: Implement a schema validation layer in FluentD that ensures logs conform to a common structure before indexing.

### Challenge 2: Noisy Neighbors

High-volume tenants could impact performance for others sharing the same index.

**Solution**: Implement per-tenant rate limiting in FluentD and monitor tenant-specific indexing rates.

### Challenge 3: Index Lifecycle Management

With shared indices, you can't have tenant-specific retention policies.

**Solution**: If truly needed, you can implement custom retention by using a script to delete documents based on `tenant_id` and age.

## Next Steps

In this second part of our series, we've:

1. Improved our logging architecture by moving to shared indices
2. Implemented document-level security to maintain tenant isolation
3. Optimized index templates and management policies
4. Created initial visualizations for tenant users

In [Part 3](/centralized-kubernetes-logging-part3/), we'll complete our logging infrastructure by implementing comprehensive monitoring of the entire stack. We'll set up Prometheus and Grafana to monitor FluentD, FluentBit, and OpenSearch, ensuring we have full visibility into the health and performance of our logging system.

Stay tuned for the final part of this series!