---
title: "SIEM Implementation and Log Analysis with ELK Stack and Splunk: Enterprise Security Operations Guide"
date: 2026-11-20T00:00:00-05:00
draft: false
tags: ["SIEM", "ELK Stack", "Elasticsearch", "Logstash", "Kibana", "Splunk", "Log Analysis", "Security Operations", "SOC", "Threat Detection", "Security Monitoring"]
categories:
- Security
- SIEM
- Log Analysis
- SOC
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Security Information and Event Management (SIEM) systems using ELK Stack and Splunk, including advanced log analysis, threat detection, and enterprise security operations center setup."
more_link: "yes"
url: "/siem-implementation-elk-stack-splunk-enterprise-security-guide/"
---

Security Information and Event Management (SIEM) systems form the cornerstone of modern enterprise security operations, providing centralized log collection, analysis, and threat detection capabilities. This comprehensive guide covers the implementation of enterprise-grade SIEM solutions using both the ELK Stack (Elasticsearch, Logstash, Kibana) and Splunk, with practical configurations for real-world security operations centers.

<!--more-->

# [SIEM Implementation and Log Analysis with ELK Stack and Splunk](#siem-implementation-elk-splunk)

## Section 1: SIEM Architecture and Planning

Enterprise SIEM implementation requires careful architectural planning to handle massive log volumes while providing real-time threat detection and compliance reporting capabilities.

### Enterprise SIEM Architecture Design

```yaml
# siem-architecture.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: siem-architecture-config
  namespace: security-ops
data:
  architecture.yaml: |
    siem_architecture:
      data_sources:
        - network_devices
        - security_appliances
        - servers_workstations
        - applications
        - cloud_services
        - databases
        - identity_systems
      
      collection_tier:
        agents:
          - beats_family
          - splunk_universal_forwarder
          - rsyslog
          - fluentd
        protocols:
          - syslog
          - snmp
          - api_polling
          - file_monitoring
      
      processing_tier:
        normalization:
          - common_event_format
          - custom_parsers
          - field_extraction
        enrichment:
          - threat_intelligence
          - geolocation
          - asset_context
        correlation:
          - rule_engine
          - machine_learning
          - statistical_analysis
      
      storage_tier:
        hot_storage:
          retention: 90_days
          performance: high_iops
        warm_storage:
          retention: 1_year
          performance: standard
        cold_storage:
          retention: 7_years
          performance: archive
      
      analytics_tier:
        real_time:
          - streaming_analytics
          - complex_event_processing
        batch_processing:
          - historical_analysis
          - trend_identification
        machine_learning:
          - anomaly_detection
          - behavioral_analysis
```

### SIEM Requirements Assessment

```go
// siem-requirements.go
package main

import (
    "encoding/json"
    "fmt"
    "time"
)

type SIEMRequirements struct {
    Organization     OrganizationProfile `json:"organization"`
    DataSources      []DataSource        `json:"data_sources"`
    Compliance       []ComplianceStandard `json:"compliance"`
    Performance      PerformanceRequirements `json:"performance"`
    Integration      IntegrationRequirements `json:"integration"`
    RetentionPolicy  RetentionPolicy     `json:"retention_policy"`
}

type OrganizationProfile struct {
    Industry         string `json:"industry"`
    Size             string `json:"size"`
    Geography        string `json:"geography"`
    RiskProfile      string `json:"risk_profile"`
    SecurityMaturity string `json:"security_maturity"`
}

type DataSource struct {
    Name           string  `json:"name"`
    Type           string  `json:"type"`
    VolumePerDay   int64   `json:"volume_per_day_gb"`
    CriticalityLevel string `json:"criticality_level"`
    Format         string  `json:"format"`
    Location       string  `json:"location"`
}

type ComplianceStandard struct {
    Standard        string   `json:"standard"`
    Requirements    []string `json:"requirements"`
    RetentionPeriod string   `json:"retention_period"`
    ReportingFreq   string   `json:"reporting_frequency"`
}

type PerformanceRequirements struct {
    MaxIngestionLatency  time.Duration `json:"max_ingestion_latency"`
    SearchResponseTime   time.Duration `json:"search_response_time"`
    AlertGenerationTime  time.Duration `json:"alert_generation_time"`
    ConcurrentUsers      int           `json:"concurrent_users"`
    DailySearchVolume    int           `json:"daily_search_volume"`
}

type IntegrationRequirements struct {
    SOAR             bool     `json:"soar_integration"`
    TicketingSystem  bool     `json:"ticketing_system"`
    ThreatIntel      bool     `json:"threat_intelligence"`
    IdentityProviders []string `json:"identity_providers"`
    APIs             []string `json:"apis"`
}

type RetentionPolicy struct {
    HotStorage   time.Duration `json:"hot_storage"`
    WarmStorage  time.Duration `json:"warm_storage"`
    ColdStorage  time.Duration `json:"cold_storage"`
    Archival     time.Duration `json:"archival"`
}

func AssessSIEMRequirements(org OrganizationProfile) (*SIEMRequirements, error) {
    requirements := &SIEMRequirements{
        Organization: org,
    }

    // Industry-specific data sources
    switch org.Industry {
    case "financial":
        requirements.DataSources = append(requirements.DataSources,
            DataSource{
                Name: "ATM_Logs",
                Type: "application",
                VolumePerDay: 50,
                CriticalityLevel: "high",
                Format: "json",
                Location: "branch_offices",
            },
            DataSource{
                Name: "Core_Banking_System",
                Type: "database",
                VolumePerDay: 200,
                CriticalityLevel: "critical",
                Format: "structured",
                Location: "data_center",
            },
        )
        requirements.Compliance = append(requirements.Compliance,
            ComplianceStandard{
                Standard: "PCI_DSS",
                Requirements: []string{"logging", "monitoring", "incident_response"},
                RetentionPeriod: "1_year",
                ReportingFreq: "quarterly",
            },
        )
    case "healthcare":
        requirements.DataSources = append(requirements.DataSources,
            DataSource{
                Name: "EMR_System",
                Type: "application",
                VolumePerDay: 100,
                CriticalityLevel: "critical",
                Format: "hl7",
                Location: "hospital_network",
            },
        )
        requirements.Compliance = append(requirements.Compliance,
            ComplianceStandard{
                Standard: "HIPAA",
                Requirements: []string{"audit_logs", "access_controls", "data_integrity"},
                RetentionPeriod: "6_years",
                ReportingFreq: "annual",
            },
        )
    }

    // Size-based performance requirements
    switch org.Size {
    case "enterprise":
        requirements.Performance = PerformanceRequirements{
            MaxIngestionLatency: 30 * time.Second,
            SearchResponseTime:  5 * time.Second,
            AlertGenerationTime: 60 * time.Second,
            ConcurrentUsers:     100,
            DailySearchVolume:   10000,
        }
    case "mid_market":
        requirements.Performance = PerformanceRequirements{
            MaxIngestionLatency: 60 * time.Second,
            SearchResponseTime:  10 * time.Second,
            AlertGenerationTime: 120 * time.Second,
            ConcurrentUsers:     25,
            DailySearchVolume:   2000,
        }
    }

    return requirements, nil
}

func CalculateResourceRequirements(req *SIEMRequirements) map[string]interface{} {
    totalDailyVolume := int64(0)
    for _, ds := range req.DataSources {
        totalDailyVolume += ds.VolumePerDay
    }

    // Storage calculations
    hotStorageDays := int(req.RetentionPolicy.HotStorage.Hours() / 24)
    warmStorageDays := int(req.RetentionPolicy.WarmStorage.Hours() / 24)
    coldStorageDays := int(req.RetentionPolicy.ColdStorage.Hours() / 24)

    hotStorageGB := totalDailyVolume * int64(hotStorageDays)
    warmStorageGB := totalDailyVolume * int64(warmStorageDays)
    coldStorageGB := totalDailyVolume * int64(coldStorageDays)

    // Compute resource calculations
    indexingNodes := (totalDailyVolume / 100) + 1  // 1 node per 100GB/day
    searchNodes := (int64(req.Performance.ConcurrentUsers) / 10) + 1
    masterNodes := int64(3) // Always 3 for HA

    return map[string]interface{}{
        "storage_requirements": map[string]interface{}{
            "hot_storage_gb":  hotStorageGB,
            "warm_storage_gb": warmStorageGB,
            "cold_storage_gb": coldStorageGB,
            "total_storage_tb": (hotStorageGB + warmStorageGB + coldStorageGB) / 1024,
        },
        "compute_requirements": map[string]interface{}{
            "indexing_nodes": indexingNodes,
            "search_nodes":   searchNodes,
            "master_nodes":   masterNodes,
            "total_nodes":    indexingNodes + searchNodes + masterNodes,
        },
        "network_requirements": map[string]interface{}{
            "ingestion_bandwidth_mbps": totalDailyVolume * 8 / (24 * 60 * 60) * 1024, // Convert GB to Mbps
            "search_bandwidth_mbps":    req.Performance.ConcurrentUsers * 10,
        },
    }
}
```

## Section 2: ELK Stack Implementation

The ELK Stack provides a powerful, open-source SIEM foundation with Elasticsearch for storage and search, Logstash for data processing, and Kibana for visualization.

### Elasticsearch Cluster Configuration

```yaml
# elasticsearch-cluster.yaml
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: siem-elasticsearch
  namespace: security-ops
spec:
  version: 8.11.0
  nodeSets:
  - name: master
    count: 3
    config:
      node.roles: ["master"]
      xpack.security.enabled: true
      xpack.security.transport.ssl.enabled: true
      xpack.security.transport.ssl.verification_mode: certificate
      xpack.security.transport.ssl.client_authentication: required
      xpack.security.transport.ssl.keystore.path: /usr/share/elasticsearch/config/certs/elastic-certificates.p12
      xpack.security.transport.ssl.truststore.path: /usr/share/elasticsearch/config/certs/elastic-certificates.p12
      xpack.security.http.ssl.enabled: true
      xpack.security.http.ssl.keystore.path: /usr/share/elasticsearch/config/certs/elastic-certificates.p12
      cluster.routing.allocation.disk.watermark.low: 85%
      cluster.routing.allocation.disk.watermark.high: 90%
      cluster.routing.allocation.disk.watermark.flood_stage: 95%
    podTemplate:
      spec:
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 4Gi
              cpu: 1
            limits:
              memory: 4Gi
              cpu: 2
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms2g -Xmx2g"
        volumes:
        - name: elasticsearch-data
          persistentVolumeClaim:
            claimName: elasticsearch-master-data
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 100Gi
        storageClassName: fast-ssd
  - name: hot-data
    count: 3
    config:
      node.roles: ["data_hot", "data_content", "ingest"]
      node.attr.data: hot
      index.codec: best_compression
    podTemplate:
      spec:
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 16Gi
              cpu: 4
            limits:
              memory: 16Gi
              cpu: 8
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms8g -Xmx8g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 2Ti
        storageClassName: fast-ssd
  - name: warm-data
    count: 3
    config:
      node.roles: ["data_warm"]
      node.attr.data: warm
    podTemplate:
      spec:
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 8Gi
              cpu: 2
            limits:
              memory: 8Gi
              cpu: 4
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms4g -Xmx4g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 5Ti
        storageClassName: standard-ssd
  - name: cold-data
    count: 2
    config:
      node.roles: ["data_cold"]
      node.attr.data: cold
    podTemplate:
      spec:
        containers:
        - name: elasticsearch
          resources:
            requests:
              memory: 4Gi
              cpu: 1
            limits:
              memory: 4Gi
              cpu: 2
          env:
          - name: ES_JAVA_OPTS
            value: "-Xms2g -Xmx2g"
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data
      spec:
        accessModes:
        - ReadWriteOnce
        resources:
          requests:
            storage: 10Ti
        storageClassName: standard-hdd
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: elasticsearch-ilm-policy
  namespace: security-ops
data:
  siem-logs-policy.json: |
    {
      "policy": {
        "phases": {
          "hot": {
            "min_age": "0ms",
            "actions": {
              "rollover": {
                "max_size": "50gb",
                "max_age": "1d"
              },
              "set_priority": {
                "priority": 100
              }
            }
          },
          "warm": {
            "min_age": "7d",
            "actions": {
              "set_priority": {
                "priority": 50
              },
              "allocate": {
                "number_of_replicas": 0,
                "include": {
                  "data": "warm"
                }
              },
              "forcemerge": {
                "max_num_segments": 1
              }
            }
          },
          "cold": {
            "min_age": "90d",
            "actions": {
              "set_priority": {
                "priority": 0
              },
              "allocate": {
                "number_of_replicas": 0,
                "include": {
                  "data": "cold"
                }
              }
            }
          },
          "delete": {
            "min_age": "2555d"
          }
        }
      }
    }
```

### Logstash Configuration for Security Log Processing

```ruby
# logstash-security-pipeline.conf
input {
  beats {
    port => 5044
  }
  
  tcp {
    port => 5514
    type => "syslog"
  }
  
  http {
    port => 8080
    type => "webhook"
  }
  
  kafka {
    bootstrap_servers => "kafka-cluster:9092"
    topics => ["security-events", "network-logs", "application-logs"]
    group_id => "logstash-security"
    consumer_threads => 4
  }
}

filter {
  # Common timestamp parsing
  date {
    match => [ "timestamp", "ISO8601", "yyyy-MM-dd HH:mm:ss", "MMM dd HH:mm:ss" ]
    target => "@timestamp"
  }
  
  # Source IP geolocation
  if [source_ip] {
    geoip {
      source => "source_ip"
      target => "source_geo"
      database => "/opt/logstash/geoip/GeoLite2-City.mmdb"
    }
  }
  
  # Windows Event Log Processing
  if [log_name] == "Security" {
    if [event_id] == 4624 {
      mutate {
        add_field => { "event_category" => "authentication" }
        add_field => { "event_action" => "logon_success" }
        add_field => { "severity" => "info" }
      }
    } else if [event_id] == 4625 {
      mutate {
        add_field => { "event_category" => "authentication" }
        add_field => { "event_action" => "logon_failure" }
        add_field => { "severity" => "warning" }
      }
    } else if [event_id] == 4648 {
      mutate {
        add_field => { "event_category" => "authentication" }
        add_field => { "event_action" => "explicit_logon" }
        add_field => { "severity" => "info" }
      }
    } else if [event_id] in [4720, 4722, 4723, 4724, 4725, 4726] {
      mutate {
        add_field => { "event_category" => "user_management" }
        add_field => { "event_action" => "user_account_change" }
        add_field => { "severity" => "warning" }
      }
    }
  }
  
  # Linux Authentication Logs
  if [type] == "syslog" and [program] == "sshd" {
    grok {
      match => { 
        "message" => "Accepted %{WORD:auth_method} for %{USER:username} from %{IPORHOST:source_ip} port %{INT:source_port} ssh2" 
      }
      add_field => { "event_category" => "authentication" }
      add_field => { "event_action" => "ssh_login_success" }
      add_field => { "severity" => "info" }
    }
    
    grok {
      match => { 
        "message" => "Failed %{WORD:auth_method} for %{USER:username} from %{IPORHOST:source_ip} port %{INT:source_port} ssh2" 
      }
      add_field => { "event_category" => "authentication" }
      add_field => { "event_action" => "ssh_login_failure" }
      add_field => { "severity" => "warning" }
    }
  }
  
  # Web Server Logs
  if [type] == "apache" or [type] == "nginx" {
    grok {
      match => { 
        "message" => "%{COMBINEDAPACHELOG}" 
      }
    }
    
    if [response] >= 400 {
      mutate {
        add_field => { "event_category" => "web_application" }
        add_field => { "event_action" => "http_error" }
        add_field => { "severity" => "warning" }
      }
    }
    
    # Detect potential attacks
    if [request] =~ /(\||;|`|\$\(|\${|<script|javascript:|vbscript:)/ {
      mutate {
        add_field => { "event_category" => "web_application" }
        add_field => { "event_action" => "potential_attack" }
        add_field => { "severity" => "high" }
        add_field => { "attack_indicators" => "command_injection_xss" }
      }
    }
  }
  
  # Firewall Logs
  if [type] == "firewall" {
    grok {
      match => { 
        "message" => "%{TIMESTAMP_ISO8601:timestamp} %{WORD:action} %{WORD:protocol} %{IP:source_ip}:%{INT:source_port} %{IP:dest_ip}:%{INT:dest_port}" 
      }
    }
    
    if [action] == "DENY" or [action] == "DROP" {
      mutate {
        add_field => { "event_category" => "network" }
        add_field => { "event_action" => "connection_blocked" }
        add_field => { "severity" => "info" }
      }
    }
  }
  
  # DNS Logs
  if [type] == "dns" {
    grok {
      match => { 
        "message" => "%{TIMESTAMP_ISO8601:timestamp} %{IP:client_ip} %{WORD:query_type} %{HOSTNAME:domain} %{IP:resolved_ip}" 
      }
    }
    
    # Check against threat intelligence feeds
    translate {
      source => "domain"
      target => "threat_category"
      dictionary_path => "/opt/logstash/dictionaries/malicious_domains.yml"
      fallback => "unknown"
    }
    
    if [threat_category] != "unknown" {
      mutate {
        add_field => { "event_category" => "threat_intelligence" }
        add_field => { "event_action" => "malicious_domain_query" }
        add_field => { "severity" => "high" }
      }
    }
  }
  
  # Threat Intelligence Enrichment
  translate {
    source => "source_ip"
    target => "threat_reputation"
    dictionary_path => "/opt/logstash/dictionaries/ip_reputation.yml"
    fallback => "unknown"
  }
  
  if [threat_reputation] != "unknown" {
    mutate {
      add_field => { "enrichment" => "threat_intelligence" }
      add_field => { "severity" => "high" }
    }
  }
  
  # Asset Enrichment
  translate {
    source => "dest_ip"
    target => "asset_criticality"
    dictionary_path => "/opt/logstash/dictionaries/asset_inventory.yml"
    fallback => "unknown"
  }
  
  # Risk Scoring
  ruby {
    code => "
      risk_score = 0
      
      # Base score from severity
      case event.get('severity')
      when 'critical'
        risk_score += 50
      when 'high'
        risk_score += 30
      when 'warning'
        risk_score += 15
      when 'info'
        risk_score += 5
      end
      
      # Increase score for threat intelligence matches
      risk_score += 25 if event.get('threat_reputation') != 'unknown'
      risk_score += 20 if event.get('threat_category') != 'unknown'
      
      # Increase score for critical assets
      risk_score += 15 if event.get('asset_criticality') == 'critical'
      risk_score += 10 if event.get('asset_criticality') == 'high'
      
      # Increase score for external sources
      if event.get('source_geo') && !event.get('source_geo')['country_code2'].nil?
        risk_score += 10 unless ['US', 'CA', 'GB'].include?(event.get('source_geo')['country_code2'])
      end
      
      event.set('risk_score', risk_score)
      
      # Set risk level
      if risk_score >= 70
        event.set('risk_level', 'critical')
      elsif risk_score >= 50
        event.set('risk_level', 'high')
      elsif risk_score >= 30
        event.set('risk_level', 'medium')
      else
        event.set('risk_level', 'low')
      end
    "
  }
  
  # Data Classification
  if [message] =~ /(\d{4}-?\d{4}-?\d{4}-?\d{4}|\d{3}-?\d{2}-?\d{4})/ {
    mutate {
      add_field => { "data_classification" => "sensitive" }
      add_field => { "pii_detected" => "true" }
    }
  }
  
  # Remove sensitive data
  if [data_classification] == "sensitive" {
    mutate {
      gsub => [
        "message", "\d{4}-?\d{4}-?\d{4}-?\d{4}", "****-****-****-****",
        "message", "\d{3}-?\d{2}-?\d{4}", "***-**-****"
      ]
    }
  }
}

output {
  # Primary SIEM storage
  elasticsearch {
    hosts => ["siem-elasticsearch-es-http:9200"]
    user => "${ELASTICSEARCH_USERNAME}"
    password => "${ELASTICSEARCH_PASSWORD}"
    ssl => true
    ssl_certificate_verification => true
    cacert => "/opt/logstash/certs/ca.crt"
    
    index => "siem-logs-%{+YYYY.MM.dd}"
    template_name => "siem-logs"
    template_pattern => "siem-logs-*"
    template => "/opt/logstash/templates/siem-logs-template.json"
    
    # Use ILM for automated lifecycle management
    ilm_enabled => true
    ilm_rollover_alias => "siem-logs"
    ilm_pattern => "{now/d}-000001"
    ilm_policy => "siem-logs-policy"
  }
  
  # High-risk events to dedicated index
  if [risk_level] == "critical" or [risk_level] == "high" {
    elasticsearch {
      hosts => ["siem-elasticsearch-es-http:9200"]
      user => "${ELASTICSEARCH_USERNAME}"
      password => "${ELASTICSEARCH_PASSWORD}"
      ssl => true
      ssl_certificate_verification => true
      cacert => "/opt/logstash/certs/ca.crt"
      
      index => "siem-alerts-%{+YYYY.MM.dd}"
      template_name => "siem-alerts"
      template_pattern => "siem-alerts-*"
    }
  }
  
  # Real-time alerting via Kafka
  if [risk_level] == "critical" {
    kafka {
      bootstrap_servers => "kafka-cluster:9092"
      topic_id => "security-alerts"
      codec => json
    }
  }
  
  # Backup to S3
  s3 {
    access_key_id => "${AWS_ACCESS_KEY_ID}"
    secret_access_key => "${AWS_SECRET_ACCESS_KEY}"
    region => "us-west-2"
    bucket => "security-logs-backup"
    prefix => "siem-logs/%{+YYYY}/%{+MM}/%{+dd}/"
    time_file => 60
    codec => json_lines
  }
  
  # Debug output for development
  if [debug] == "true" {
    stdout { 
      codec => json 
    }
  }
}
```

### Advanced Security Correlation Rules

```go
// correlation-engine.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/elastic/go-elasticsearch/v8"
    "github.com/elastic/go-elasticsearch/v8/esapi"
)

type CorrelationEngine struct {
    esClient    *elasticsearch.Client
    rules       []CorrelationRule
    eventBuffer map[string][]SecurityEvent
    mutex       sync.RWMutex
    alertChan   chan SecurityAlert
}

type CorrelationRule struct {
    ID          string        `json:"id"`
    Name        string        `json:"name"`
    Description string        `json:"description"`
    Severity    string        `json:"severity"`
    TimeWindow  time.Duration `json:"time_window"`
    Threshold   int           `json:"threshold"`
    Conditions  []Condition   `json:"conditions"`
    Actions     []Action      `json:"actions"`
    Enabled     bool          `json:"enabled"`
}

type Condition struct {
    Field     string      `json:"field"`
    Operator  string      `json:"operator"`
    Value     interface{} `json:"value"`
    LogicOp   string      `json:"logic_op,omitempty"`
}

type Action struct {
    Type   string                 `json:"type"`
    Config map[string]interface{} `json:"config"`
}

type SecurityEvent struct {
    Timestamp       time.Time              `json:"@timestamp"`
    EventCategory   string                 `json:"event_category"`
    EventAction     string                 `json:"event_action"`
    Severity        string                 `json:"severity"`
    SourceIP        string                 `json:"source_ip"`
    DestIP          string                 `json:"dest_ip"`
    Username        string                 `json:"username"`
    RiskScore       int                    `json:"risk_score"`
    RiskLevel       string                 `json:"risk_level"`
    Metadata        map[string]interface{} `json:"metadata"`
}

type SecurityAlert struct {
    ID              string                 `json:"id"`
    RuleID          string                 `json:"rule_id"`
    RuleName        string                 `json:"rule_name"`
    Severity        string                 `json:"severity"`
    Description     string                 `json:"description"`
    Events          []SecurityEvent        `json:"events"`
    CreatedAt       time.Time              `json:"created_at"`
    AggregateScore  int                    `json:"aggregate_score"`
    ThreatActors    []string               `json:"threat_actors,omitempty"`
    MITRE_TTPs      []string               `json:"mitre_ttps,omitempty"`
    Recommendations []string               `json:"recommendations"`
}

func NewCorrelationEngine(esClient *elasticsearch.Client) *CorrelationEngine {
    return &CorrelationEngine{
        esClient:    esClient,
        rules:       loadCorrelationRules(),
        eventBuffer: make(map[string][]SecurityEvent),
        alertChan:   make(chan SecurityAlert, 1000),
    }
}

func loadCorrelationRules() []CorrelationRule {
    return []CorrelationRule{
        {
            ID:          "BRUTE_FORCE_ATTACK",
            Name:        "Brute Force Authentication Attack",
            Description: "Multiple failed authentication attempts from the same source",
            Severity:    "high",
            TimeWindow:  15 * time.Minute,
            Threshold:   5,
            Conditions: []Condition{
                {
                    Field:    "event_category",
                    Operator: "equals",
                    Value:    "authentication",
                },
                {
                    Field:    "event_action",
                    Operator: "equals",
                    Value:    "logon_failure",
                    LogicOp:  "AND",
                },
            },
            Actions: []Action{
                {
                    Type: "alert",
                    Config: map[string]interface{}{
                        "priority": "high",
                        "notify":   []string{"soc@company.com"},
                    },
                },
                {
                    Type: "block_ip",
                    Config: map[string]interface{}{
                        "duration": "1h",
                    },
                },
            },
            Enabled: true,
        },
        {
            ID:          "LATERAL_MOVEMENT",
            Name:        "Lateral Movement Detection",
            Description: "Successful authentication followed by suspicious network activity",
            Severity:    "critical",
            TimeWindow:  30 * time.Minute,
            Threshold:   1,
            Conditions: []Condition{
                {
                    Field:    "event_category",
                    Operator: "equals",
                    Value:    "authentication",
                },
                {
                    Field:    "event_action",
                    Operator: "equals",
                    Value:    "logon_success",
                    LogicOp:  "AND",
                },
                {
                    Field:    "risk_score",
                    Operator: "greater_than",
                    Value:    40,
                    LogicOp:  "AND",
                },
            },
            Actions: []Action{
                {
                    Type: "alert",
                    Config: map[string]interface{}{
                        "priority": "critical",
                        "escalate": true,
                    },
                },
                {
                    Type: "quarantine_user",
                    Config: map[string]interface{}{
                        "temporary": true,
                    },
                },
            },
            Enabled: true,
        },
        {
            ID:          "DATA_EXFILTRATION",
            Name:        "Data Exfiltration Attempt",
            Description: "Large volume of data transfer to external destinations",
            Severity:    "critical",
            TimeWindow:  1 * time.Hour,
            Threshold:   1,
            Conditions: []Condition{
                {
                    Field:    "event_category",
                    Operator: "equals",
                    Value:    "network",
                },
                {
                    Field:    "bytes_out",
                    Operator: "greater_than",
                    Value:    10485760, // 10MB
                    LogicOp:  "AND",
                },
                {
                    Field:    "dest_ip_internal",
                    Operator: "equals",
                    Value:    false,
                    LogicOp:  "AND",
                },
            },
            Actions: []Action{
                {
                    Type: "alert",
                    Config: map[string]interface{}{
                        "priority": "critical",
                        "immediate": true,
                    },
                },
                {
                    Type: "network_block",
                    Config: map[string]interface{}{
                        "block_external": true,
                    },
                },
            },
            Enabled: true,
        },
    }
}

func (ce *CorrelationEngine) Start(ctx context.Context) error {
    // Start event processing goroutine
    go ce.processEvents(ctx)
    
    // Start alert processing goroutine
    go ce.processAlerts(ctx)
    
    // Start rule evaluation goroutine
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            ce.evaluateRules()
        }
    }
}

func (ce *CorrelationEngine) processEvents(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
            events, err := ce.fetchLatestEvents()
            if err != nil {
                log.Printf("Error fetching events: %v", err)
                time.Sleep(5 * time.Second)
                continue
            }
            
            ce.bufferEvents(events)
            time.Sleep(10 * time.Second)
        }
    }
}

func (ce *CorrelationEngine) fetchLatestEvents() ([]SecurityEvent, error) {
    query := map[string]interface{}{
        "query": map[string]interface{}{
            "range": map[string]interface{}{
                "@timestamp": map[string]interface{}{
                    "gte": "now-1m",
                },
            },
        },
        "sort": []map[string]interface{}{
            {
                "@timestamp": map[string]interface{}{
                    "order": "desc",
                },
            },
        },
        "size": 1000,
    }
    
    var buf bytes.Buffer
    if err := json.NewEncoder(&buf).Encode(query); err != nil {
        return nil, err
    }
    
    req := esapi.SearchRequest{
        Index: []string{"siem-logs-*"},
        Body:  &buf,
    }
    
    res, err := req.Do(ctx, ce.esClient)
    if err != nil {
        return nil, err
    }
    defer res.Body.Close()
    
    var response map[string]interface{}
    if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
        return nil, err
    }
    
    hits := response["hits"].(map[string]interface{})["hits"].([]interface{})
    events := make([]SecurityEvent, 0, len(hits))
    
    for _, hit := range hits {
        hitMap := hit.(map[string]interface{})
        source := hitMap["_source"].(map[string]interface{})
        
        var event SecurityEvent
        eventBytes, _ := json.Marshal(source)
        json.Unmarshal(eventBytes, &event)
        
        events = append(events, event)
    }
    
    return events, nil
}

func (ce *CorrelationEngine) bufferEvents(events []SecurityEvent) {
    ce.mutex.Lock()
    defer ce.mutex.Unlock()
    
    now := time.Now()
    
    for _, event := range events {
        key := ce.getBufferKey(event)
        ce.eventBuffer[key] = append(ce.eventBuffer[key], event)
    }
    
    // Clean up old events
    for key, events := range ce.eventBuffer {
        filtered := make([]SecurityEvent, 0)
        for _, event := range events {
            if now.Sub(event.Timestamp) < 1*time.Hour {
                filtered = append(filtered, event)
            }
        }
        if len(filtered) == 0 {
            delete(ce.eventBuffer, key)
        } else {
            ce.eventBuffer[key] = filtered
        }
    }
}

func (ce *CorrelationEngine) getBufferKey(event SecurityEvent) string {
    return fmt.Sprintf("%s:%s:%s", event.EventCategory, event.SourceIP, event.Username)
}

func (ce *CorrelationEngine) evaluateRules() {
    ce.mutex.RLock()
    defer ce.mutex.RUnlock()
    
    for _, rule := range ce.rules {
        if !rule.Enabled {
            continue
        }
        
        for key, events := range ce.eventBuffer {
            if ce.evaluateRule(rule, events) {
                alert := ce.createAlert(rule, events)
                select {
                case ce.alertChan <- alert:
                default:
                    log.Printf("Alert channel full, dropping alert: %s", alert.ID)
                }
            }
        }
    }
}

func (ce *CorrelationEngine) evaluateRule(rule CorrelationRule, events []SecurityEvent) bool {
    now := time.Now()
    relevantEvents := make([]SecurityEvent, 0)
    
    // Filter events within time window
    for _, event := range events {
        if now.Sub(event.Timestamp) <= rule.TimeWindow {
            if ce.matchesConditions(rule.Conditions, event) {
                relevantEvents = append(relevantEvents, event)
            }
        }
    }
    
    return len(relevantEvents) >= rule.Threshold
}

func (ce *CorrelationEngine) matchesConditions(conditions []Condition, event SecurityEvent) bool {
    if len(conditions) == 0 {
        return true
    }
    
    result := ce.evaluateCondition(conditions[0], event)
    
    for i := 1; i < len(conditions); i++ {
        condition := conditions[i]
        conditionResult := ce.evaluateCondition(condition, event)
        
        switch condition.LogicOp {
        case "AND":
            result = result && conditionResult
        case "OR":
            result = result || conditionResult
        default:
            result = result && conditionResult
        }
    }
    
    return result
}

func (ce *CorrelationEngine) evaluateCondition(condition Condition, event SecurityEvent) bool {
    var fieldValue interface{}
    
    switch condition.Field {
    case "event_category":
        fieldValue = event.EventCategory
    case "event_action":
        fieldValue = event.EventAction
    case "severity":
        fieldValue = event.Severity
    case "source_ip":
        fieldValue = event.SourceIP
    case "username":
        fieldValue = event.Username
    case "risk_score":
        fieldValue = event.RiskScore
    default:
        if val, exists := event.Metadata[condition.Field]; exists {
            fieldValue = val
        } else {
            return false
        }
    }
    
    switch condition.Operator {
    case "equals":
        return fieldValue == condition.Value
    case "not_equals":
        return fieldValue != condition.Value
    case "greater_than":
        if fv, ok := fieldValue.(int); ok {
            if cv, ok := condition.Value.(int); ok {
                return fv > cv
            }
        }
    case "less_than":
        if fv, ok := fieldValue.(int); ok {
            if cv, ok := condition.Value.(int); ok {
                return fv < cv
            }
        }
    case "contains":
        if fv, ok := fieldValue.(string); ok {
            if cv, ok := condition.Value.(string); ok {
                return strings.Contains(fv, cv)
            }
        }
    }
    
    return false
}

func (ce *CorrelationEngine) createAlert(rule CorrelationRule, events []SecurityEvent) SecurityAlert {
    now := time.Now()
    alertID := fmt.Sprintf("%s-%d", rule.ID, now.Unix())
    
    // Calculate aggregate risk score
    totalScore := 0
    for _, event := range events {
        totalScore += event.RiskScore
    }
    avgScore := totalScore / len(events)
    
    // Generate MITRE ATT&CK TTPs based on rule
    var mitreTTPs []string
    switch rule.ID {
    case "BRUTE_FORCE_ATTACK":
        mitreTTPs = []string{"T1110", "T1078"}
    case "LATERAL_MOVEMENT":
        mitreTTPs = []string{"T1021", "T1055", "T1570"}
    case "DATA_EXFILTRATION":
        mitreTTPs = []string{"T1041", "T1048", "T1567"}
    }
    
    return SecurityAlert{
        ID:              alertID,
        RuleID:          rule.ID,
        RuleName:        rule.Name,
        Severity:        rule.Severity,
        Description:     rule.Description,
        Events:          events,
        CreatedAt:       now,
        AggregateScore:  avgScore,
        MITRE_TTPs:      mitreTTPs,
        Recommendations: generateRecommendations(rule.ID),
    }
}

func generateRecommendations(ruleID string) []string {
    recommendations := map[string][]string{
        "BRUTE_FORCE_ATTACK": {
            "Implement account lockout policies",
            "Enable multi-factor authentication",
            "Monitor for credential stuffing attacks",
            "Review source IP reputation",
        },
        "LATERAL_MOVEMENT": {
            "Isolate affected systems",
            "Reset credentials for compromised accounts",
            "Review privileged access",
            "Conduct forensic analysis",
        },
        "DATA_EXFILTRATION": {
            "Block external network connections",
            "Review data access logs",
            "Assess data classification",
            "Notify data protection officer",
        },
    }
    
    if recs, exists := recommendations[ruleID]; exists {
        return recs
    }
    
    return []string{"Review security policies", "Investigate further"}
}

func (ce *CorrelationEngine) processAlerts(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case alert := <-ce.alertChan:
            ce.handleAlert(alert)
        }
    }
}

func (ce *CorrelationEngine) handleAlert(alert SecurityAlert) {
    // Store alert in Elasticsearch
    ce.storeAlert(alert)
    
    // Execute rule actions
    rule := ce.getRuleByID(alert.RuleID)
    if rule != nil {
        for _, action := range rule.Actions {
            ce.executeAction(action, alert)
        }
    }
}

func (ce *CorrelationEngine) storeAlert(alert SecurityAlert) error {
    alertBytes, err := json.Marshal(alert)
    if err != nil {
        return err
    }
    
    req := esapi.IndexRequest{
        Index:      "siem-alerts",
        DocumentID: alert.ID,
        Body:       bytes.NewReader(alertBytes),
    }
    
    res, err := req.Do(context.Background(), ce.esClient)
    if err != nil {
        return err
    }
    defer res.Body.Close()
    
    return nil
}

func (ce *CorrelationEngine) getRuleByID(ruleID string) *CorrelationRule {
    for _, rule := range ce.rules {
        if rule.ID == ruleID {
            return &rule
        }
    }
    return nil
}

func (ce *CorrelationEngine) executeAction(action Action, alert SecurityAlert) {
    switch action.Type {
    case "alert":
        ce.sendNotification(alert, action.Config)
    case "block_ip":
        ce.blockIP(alert, action.Config)
    case "quarantine_user":
        ce.quarantineUser(alert, action.Config)
    case "network_block":
        ce.blockNetwork(alert, action.Config)
    }
}

func (ce *CorrelationEngine) sendNotification(alert SecurityAlert, config map[string]interface{}) {
    // Implementation for sending notifications
    log.Printf("ALERT: %s - %s (Severity: %s)", alert.RuleName, alert.Description, alert.Severity)
}

func (ce *CorrelationEngine) blockIP(alert SecurityAlert, config map[string]interface{}) {
    // Implementation for IP blocking
    for _, event := range alert.Events {
        if event.SourceIP != "" {
            log.Printf("Blocking IP: %s", event.SourceIP)
        }
    }
}

func (ce *CorrelationEngine) quarantineUser(alert SecurityAlert, config map[string]interface{}) {
    // Implementation for user quarantine
    for _, event := range alert.Events {
        if event.Username != "" {
            log.Printf("Quarantining user: %s", event.Username)
        }
    }
}

func (ce *CorrelationEngine) blockNetwork(alert SecurityAlert, config map[string]interface{}) {
    // Implementation for network blocking
    log.Printf("Implementing network blocks for alert: %s", alert.ID)
}
```

## Section 3: Splunk Implementation

Splunk provides a comprehensive commercial SIEM platform with advanced analytics, machine learning capabilities, and extensive integration options.

### Splunk Enterprise Configuration

```conf
# inputs.conf
[tcpout]
defaultGroup = primary_indexers
forwardedindex.filter.disable = true
indexAndForward = false

[tcpout:primary_indexers]
server = splunk-indexer1:9997, splunk-indexer2:9997, splunk-indexer3:9997
compressed = true
useACK = true

[splunktcp://9997]
disabled = false
route = has_key

# Windows Event Logs
[WinEventLog://Security]
disabled = false
start_from = oldest
current_only = false
evt_resolve_ad_obj = true
checkpointInterval = 5
blacklist1 = EventCode="4662" Message="Object Type:(?!\s*groupPolicyContainer)"
blacklist2 = EventCode="566" Message="Object Type:(?!\s*groupPolicyContainer)"

[WinEventLog://System]
disabled = false
start_from = oldest
current_only = false

[WinEventLog://Application]
disabled = false
start_from = oldest
current_only = false

# Syslog
[udp://514]
disabled = false
sourcetype = syslog
no_priority_stripping = true
no_appending_timestamp = true

# Web server logs
[monitor:///var/log/apache2/access.log]
disabled = false
sourcetype = access_combined
host_segment = 3

[monitor:///var/log/nginx/access.log]
disabled = false
sourcetype = nginx_access
host_segment = 3

# Network device logs
[udp://1514]
disabled = false
sourcetype = cisco:ios
no_priority_stripping = true
```

```conf
# props.conf
[WinEventLog:Security]
SHOULD_LINEMERGE = false
TRUNCATE = 100000
KV_MODE = xml
AUTO_KV_JSON = false
SEDCMD-remove_spaces = s/\s+/ /g

[WinEventLog:System]
SHOULD_LINEMERGE = false
TRUNCATE = 100000
KV_MODE = xml

[syslog]
SHOULD_LINEMERGE = false
TRUNCATE = 10000
TIME_PREFIX = ^
TIME_FORMAT = %b %d %H:%M:%S
MAX_TIMESTAMP_LOOKAHEAD = 25
KV_MODE = none

[cisco:ios]
SHOULD_LINEMERGE = false
TRUNCATE = 10000
TIME_PREFIX = ^\*
TIME_FORMAT = %b %d %H:%M:%S.%3N
MAX_TIMESTAMP_LOOKAHEAD = 25

[nginx_access]
SHOULD_LINEMERGE = false
TRUNCATE = 10000
TIME_PREFIX = \[
TIME_FORMAT = %d/%b/%Y:%H:%M:%S %z
MAX_TIMESTAMP_LOOKAHEAD = 28
EXTRACT-method,uri,version,status,bytes = ^(?:[^ \n]* ){5}(?P<method>[A-Z]+) (?P<uri>\S+) HTTP/(?P<version>[^ ]+)" (?P<status>\d+) (?P<bytes>\d+)
EXTRACT-clientip = ^(?P<clientip>[^ ]+)
```

### Advanced Splunk Search Queries

```spl
# Brute Force Attack Detection
index=security EventCode=4625 OR EventCode=4624
| eval user=coalesce(Account_Name, TargetUserName, user)
| eval src_ip=coalesce(Source_Network_Address, IpAddress, src)
| eval status=case(
    EventCode==4624, "success",
    EventCode==4625, "failure",
    1==1, "unknown"
)
| stats 
    count(eval(status="failure")) as failures,
    count(eval(status="success")) as successes,
    values(status) as statuses,
    earliest(_time) as first_attempt,
    latest(_time) as last_attempt
    by user, src_ip
| where failures >= 5
| eval duration=last_attempt-first_attempt
| eval attempts_per_minute=round((failures+successes)/(duration/60), 2)
| eval risk_score=case(
    failures >= 20, 90,
    failures >= 10, 70,
    failures >= 5, 50,
    1==1, 30
)
| table user, src_ip, failures, successes, attempts_per_minute, risk_score
| sort -risk_score

# Lateral Movement Detection
(index=security EventCode=4624 Logon_Type=3) OR (index=security EventCode=4648)
| eval user=coalesce(Account_Name, TargetUserName, user)
| eval src_ip=coalesce(Source_Network_Address, IpAddress, src)
| eval dest_host=coalesce(Computer, dest)
| transaction user maxspan=30m
| eval host_count=mvcount(split(dest_host, " "))
| where host_count > 3
| eval lateral_movement_score=case(
    host_count >= 10, 95,
    host_count >= 7, 80,
    host_count >= 5, 65,
    host_count >= 3, 50,
    1==1, 30
)
| table user, src_ip, host_count, lateral_movement_score, dest_host
| sort -lateral_movement_score

# Suspicious PowerShell Activity
index=security EventCode=4103 OR EventCode=4104
| eval command=coalesce(ScriptBlockText, CommandLine)
| eval suspicious_keywords=if(
    match(command, "(?i)(invoke-expression|iex|downloadstring|webclient|base64|bypass|hidden|encoded|compressed|obfuscated)"),
    "true",
    "false"
)
| where suspicious_keywords="true"
| eval risk_indicators=case(
    match(command, "(?i)(bypass.*execution.*policy)"), "execution_policy_bypass",
    match(command, "(?i)(hidden.*window)"), "hidden_window",
    match(command, "(?i)(base64.*decode)"), "base64_encoding",
    match(command, "(?i)(downloadstring|webclient)"), "remote_download",
    match(command, "(?i)(invoke-expression|iex)"), "code_execution",
    1==1, "general_suspicious"
)
| stats 
    count,
    values(risk_indicators) as indicators,
    values(command) as commands
    by user, host
| eval risk_score=case(
    mvcount(indicators) >= 3, 90,
    mvcount(indicators) >= 2, 70,
    count >= 10, 60,
    1==1, 40
)
| sort -risk_score

# Network Anomaly Detection
index=network 
| eval src_internal=if(cidrmatch("10.0.0.0/8", src_ip) OR cidrmatch("172.16.0.0/12", src_ip) OR cidrmatch("192.168.0.0/16", src_ip), "true", "false")
| eval dest_internal=if(cidrmatch("10.0.0.0/8", dest_ip) OR cidrmatch("172.16.0.0/12", dest_ip) OR cidrmatch("192.168.0.0/16", dest_ip), "true", "false")
| eval connection_type=case(
    src_internal="true" AND dest_internal="true", "internal",
    src_internal="true" AND dest_internal="false", "outbound",
    src_internal="false" AND dest_internal="true", "inbound",
    1==1, "external"
)
| stats 
    sum(bytes_out) as total_bytes_out,
    sum(bytes_in) as total_bytes_in,
    dc(dest_ip) as unique_destinations,
    dc(dest_port) as unique_ports,
    count as connection_count
    by src_ip, connection_type, user
| eval anomaly_score=0
| eval anomaly_score=anomaly_score + if(total_bytes_out > 1073741824, 30, 0)  # >1GB outbound
| eval anomaly_score=anomaly_score + if(unique_destinations > 100, 25, 0)     # >100 destinations
| eval anomaly_score=anomaly_score + if(unique_ports > 50, 20, 0)             # >50 ports
| eval anomaly_score=anomaly_score + if(connection_count > 10000, 25, 0)      # >10k connections
| where anomaly_score > 40
| sort -anomaly_score

# Data Exfiltration Detection
index=proxy OR index=network
| eval domain=coalesce(uri_domain, dest_domain, domain)
| eval bytes_transferred=coalesce(bytes_out, bytes)
| lookup threat_intel_domains domain OUTPUT threat_category
| eval is_external=if(
    NOT (cidrmatch("10.0.0.0/8", dest_ip) OR cidrmatch("172.16.0.0/12", dest_ip) OR cidrmatch("192.168.0.0/16", dest_ip)),
    "true",
    "false"
)
| where is_external="true"
| stats 
    sum(bytes_transferred) as total_bytes,
    dc(domain) as unique_domains,
    values(threat_category) as threat_categories,
    count as requests
    by user, src_ip
| eval exfiltration_risk=case(
    total_bytes > 5368709120, 95,  # >5GB
    total_bytes > 1073741824, 80,  # >1GB
    total_bytes > 104857600, 60,   # >100MB
    1==1, 20
)
| eval exfiltration_risk=if(
    match(threat_categories, "malicious"), 
    exfiltration_risk + 30, 
    exfiltration_risk
)
| where exfiltration_risk > 50
| sort -exfiltration_risk

# Threat Intelligence Correlation
index=* 
| eval ip_fields=mvappend(src_ip, dest_ip, clientip, server_ip)
| mvexpand ip_fields
| lookup threat_intel_ips ip_fields OUTPUT threat_score, threat_category, last_seen
| where isnotnull(threat_score) AND threat_score > 50
| stats 
    values(threat_category) as categories,
    max(threat_score) as max_threat_score,
    values(index) as affected_indexes,
    count as events
    by ip_fields, user, host
| eval correlation_score=case(
    max_threat_score >= 90, 95,
    max_threat_score >= 70, 80,
    max_threat_score >= 50, 65,
    1==1, 40
)
| eval correlation_score=if(events > 10, correlation_score + 10, correlation_score)
| sort -correlation_score
```

This comprehensive SIEM implementation guide provides enterprise-grade security operations capabilities using both open-source ELK Stack and commercial Splunk solutions. The implementation includes advanced correlation rules, threat detection logic, and practical configurations for real-world security operations centers. Organizations should customize these implementations based on their specific threat landscape, compliance requirements, and operational constraints.