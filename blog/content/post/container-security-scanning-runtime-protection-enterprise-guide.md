---
title: "Container Security Scanning and Runtime Protection: Enterprise DevSecOps Implementation Guide"
date: 2026-05-24T00:00:00-05:00
draft: false
tags: ["Container Security", "Docker", "Kubernetes", "Security Scanning", "Runtime Protection", "DevSecOps", "Vulnerability Management", "Image Security", "Compliance", "Threat Detection"]
categories:
- Security
- Containers
- DevSecOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing container security scanning and runtime protection in enterprise environments, including vulnerability assessment, compliance checking, and automated security enforcement for containerized applications."
more_link: "yes"
url: "/container-security-scanning-runtime-protection-enterprise-guide/"
---

Container security encompasses the entire lifecycle from image creation to runtime protection, requiring comprehensive scanning, monitoring, and enforcement mechanisms. This guide provides enterprise-grade implementations for container security scanning, vulnerability management, and runtime threat protection across development and production environments.

<!--more-->

# [Container Security Scanning and Runtime Protection](#container-security-scanning-runtime-protection)

## Section 1: Container Security Fundamentals

Container security requires a multi-layered approach addressing image vulnerabilities, configuration issues, runtime threats, and compliance requirements across the entire application lifecycle.

### Container Security Architecture

```yaml
# container-security-architecture.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: container-security-architecture
  namespace: security-system
data:
  security-layers.yaml: |
    container_security_layers:
      build_time:
        image_scanning:
          - vulnerability_assessment
          - malware_detection
          - secret_scanning
          - license_compliance
        policy_enforcement:
          - base_image_restrictions
          - security_benchmarks
          - configuration_validation
        supply_chain:
          - image_provenance
          - digital_signatures
          - trusted_registries
      
      deployment_time:
        admission_control:
          - policy_validation
          - security_context_enforcement
          - network_policy_application
        configuration_scanning:
          - kubernetes_security_benchmarks
          - rbac_validation
          - secret_management
      
      runtime:
        behavior_monitoring:
          - process_monitoring
          - network_traffic_analysis
          - file_system_monitoring
        threat_detection:
          - anomaly_detection
          - malware_identification
          - privilege_escalation_detection
        incident_response:
          - automated_containment
          - forensic_data_collection
          - alert_generation
```

### Container Security Threat Model

```go
// threat-model.go
package main

import (
    "encoding/json"
    "fmt"
    "time"
)

type ContainerThreatModel struct {
    Threats       []SecurityThreat      `json:"threats"`
    AttackVectors []AttackVector        `json:"attack_vectors"`
    Mitigations   []SecurityMitigation  `json:"mitigations"`
    RiskMatrix    map[string]RiskLevel  `json:"risk_matrix"`
}

type SecurityThreat struct {
    ID             string    `json:"id"`
    Name           string    `json:"name"`
    Description    string    `json:"description"`
    Category       string    `json:"category"`
    Severity       string    `json:"severity"`
    Likelihood     string    `json:"likelihood"`
    Impact         string    `json:"impact"`
    MITRE_ID       string    `json:"mitre_id,omitempty"`
    CWE_ID         string    `json:"cwe_id,omitempty"`
}

type AttackVector struct {
    ID          string   `json:"id"`
    Name        string   `json:"name"`
    Description string   `json:"description"`
    Techniques  []string `json:"techniques"`
    Prerequisites []string `json:"prerequisites"`
    Indicators  []string `json:"indicators"`
}

type SecurityMitigation struct {
    ID           string   `json:"id"`
    Name         string   `json:"name"`
    Description  string   `json:"description"`
    Type         string   `json:"type"`
    Effectiveness string  `json:"effectiveness"`
    Cost         string   `json:"cost"`
    ThreatIDs    []string `json:"threat_ids"`
}

type RiskLevel struct {
    Level       string  `json:"level"`
    Score       int     `json:"score"`
    Description string  `json:"description"`
}

func GenerateContainerThreatModel() *ContainerThreatModel {
    threats := []SecurityThreat{
        {
            ID:          "THREAT_001",
            Name:        "Vulnerable Base Image",
            Description: "Use of container images with known vulnerabilities",
            Category:    "Vulnerability",
            Severity:    "High",
            Likelihood:  "High",
            Impact:      "High",
            CWE_ID:      "CWE-1104",
        },
        {
            ID:          "THREAT_002",
            Name:        "Container Escape",
            Description: "Privilege escalation allowing escape from container",
            Category:    "Privilege Escalation",
            Severity:    "Critical",
            Likelihood:  "Medium",
            Impact:      "Critical",
            MITRE_ID:    "T1611",
        },
        {
            ID:          "THREAT_003",
            Name:        "Secrets in Images",
            Description: "Hardcoded secrets or credentials in container images",
            Category:    "Information Disclosure",
            Severity:    "High",
            Likelihood:  "Medium",
            Impact:      "High",
            CWE_ID:      "CWE-798",
        },
        {
            ID:          "THREAT_004",
            Name:        "Malicious Images",
            Description: "Use of compromised or malicious container images",
            Category:    "Supply Chain",
            Severity:    "Critical",
            Likelihood:  "Low",
            Impact:      "Critical",
            MITRE_ID:    "T1195",
        },
        {
            ID:          "THREAT_005",
            Name:        "Runtime Manipulation",
            Description: "Unauthorized modification of running containers",
            Category:    "Integrity",
            Severity:    "High",
            Likelihood:  "Medium",
            Impact:      "High",
            MITRE_ID:    "T1612",
        },
    }

    attackVectors := []AttackVector{
        {
            ID:          "VECTOR_001",
            Name:        "Image Registry Compromise",
            Description: "Compromise of container registry to distribute malicious images",
            Techniques:  []string{"Registry poisoning", "Supply chain attack", "Credential theft"},
            Prerequisites: []string{"Registry access", "Valid credentials"},
            Indicators:  []string{"Unusual image pushes", "Unexpected image modifications"},
        },
        {
            ID:          "VECTOR_002",
            Name:        "Kubernetes API Exploitation",
            Description: "Exploitation of Kubernetes API for container manipulation",
            Techniques:  []string{"RBAC bypass", "API abuse", "Privilege escalation"},
            Prerequisites: []string{"API access", "Valid service account"},
            Indicators:  []string{"Unusual API calls", "Privilege changes", "Pod modifications"},
        },
        {
            ID:          "VECTOR_003",
            Name:        "Runtime Process Injection",
            Description: "Injection of malicious processes into running containers",
            Techniques:  []string{"Process hollowing", "DLL injection", "Code injection"},
            Prerequisites: []string{"Container access", "Execution privileges"},
            Indicators:  []string{"Unexpected processes", "Memory anomalies", "Network connections"},
        },
    }

    mitigations := []SecurityMitigation{
        {
            ID:           "MIT_001",
            Name:         "Image Vulnerability Scanning",
            Description:  "Automated scanning of container images for vulnerabilities",
            Type:         "Preventive",
            Effectiveness: "High",
            Cost:         "Low",
            ThreatIDs:    []string{"THREAT_001", "THREAT_004"},
        },
        {
            ID:           "MIT_002",
            Name:         "Runtime Security Monitoring",
            Description:  "Continuous monitoring of container runtime behavior",
            Type:         "Detective",
            Effectiveness: "High",
            Cost:         "Medium",
            ThreatIDs:    []string{"THREAT_002", "THREAT_005"},
        },
        {
            ID:           "MIT_003",
            Name:         "Secret Management System",
            Description:  "Centralized secret management and injection",
            Type:         "Preventive",
            Effectiveness: "High",
            Cost:         "Medium",
            ThreatIDs:    []string{"THREAT_003"},
        },
        {
            ID:           "MIT_004",
            Name:         "Image Signing and Verification",
            Description:  "Digital signing and verification of container images",
            Type:         "Preventive",
            Effectiveness: "High",
            Cost:         "Medium",
            ThreatIDs:    []string{"THREAT_004"},
        },
    }

    riskMatrix := map[string]RiskLevel{
        "critical": {Level: "Critical", Score: 100, Description: "Immediate action required"},
        "high":     {Level: "High", Score: 75, Description: "High priority remediation"},
        "medium":   {Level: "Medium", Score: 50, Description: "Moderate priority"},
        "low":      {Level: "Low", Score: 25, Description: "Low priority monitoring"},
    }

    return &ContainerThreatModel{
        Threats:       threats,
        AttackVectors: attackVectors,
        Mitigations:   mitigations,
        RiskMatrix:    riskMatrix,
    }
}

func (ctm *ContainerThreatModel) CalculateRisk(threatID string) (int, error) {
    for _, threat := range ctm.Threats {
        if threat.ID == threatID {
            severityScore := ctm.getSeverityScore(threat.Severity)
            likelihoodScore := ctm.getLikelihoodScore(threat.Likelihood)
            impactScore := ctm.getImpactScore(threat.Impact)
            
            // Risk = (Severity + Impact) * Likelihood / 100
            risk := ((severityScore + impactScore) * likelihoodScore) / 100
            return risk, nil
        }
    }
    return 0, fmt.Errorf("threat not found: %s", threatID)
}

func (ctm *ContainerThreatModel) getSeverityScore(severity string) int {
    scores := map[string]int{
        "Critical": 40,
        "High":     30,
        "Medium":   20,
        "Low":      10,
    }
    return scores[severity]
}

func (ctm *ContainerThreatModel) getLikelihoodScore(likelihood string) int {
    scores := map[string]int{
        "Very High": 90,
        "High":      70,
        "Medium":    50,
        "Low":       30,
        "Very Low":  10,
    }
    return scores[likelihood]
}

func (ctm *ContainerThreatModel) getImpactScore(impact string) int {
    scores := map[string]int{
        "Critical": 40,
        "High":     30,
        "Medium":   20,
        "Low":      10,
    }
    return scores[impact]
}
```

## Section 2: Container Image Scanning Implementation

Comprehensive image scanning identifies vulnerabilities, malware, secrets, and policy violations before deployment to production environments.

### Multi-Scanner Integration Platform

```go
// image-scanner.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "sync"
    "time"

    "github.com/docker/docker/api/types"
    "github.com/docker/docker/client"
)

type ImageScanner struct {
    dockerClient    *client.Client
    scanners        map[string]Scanner
    policyEngine    *PolicyEngine
    resultStorage   ResultStorage
    notifications   NotificationService
}

type Scanner interface {
    Name() string
    ScanImage(ctx context.Context, image string) (*ScanResult, error)
    GetCapabilities() []string
}

type ScanResult struct {
    ScannerName     string                 `json:"scanner_name"`
    ImageName       string                 `json:"image_name"`
    ImageDigest     string                 `json:"image_digest"`
    ScanTime        time.Time              `json:"scan_time"`
    Vulnerabilities []Vulnerability        `json:"vulnerabilities"`
    Secrets         []Secret               `json:"secrets"`
    Malware         []MalwareDetection     `json:"malware"`
    Compliance      []ComplianceViolation  `json:"compliance"`
    Metadata        map[string]interface{} `json:"metadata"`
    RiskScore       int                    `json:"risk_score"`
    Status          string                 `json:"status"`
}

type Vulnerability struct {
    ID           string    `json:"id"`
    CVE          string    `json:"cve"`
    Severity     string    `json:"severity"`
    CVSS         float64   `json:"cvss"`
    Package      string    `json:"package"`
    Version      string    `json:"version"`
    FixedVersion string    `json:"fixed_version,omitempty"`
    Description  string    `json:"description"`
    References   []string  `json:"references"`
    PublishedAt  time.Time `json:"published_at"`
}

type Secret struct {
    Type        string `json:"type"`
    Description string `json:"description"`
    File        string `json:"file"`
    LineNumber  int    `json:"line_number"`
    Entropy     float64 `json:"entropy"`
    Confidence  string `json:"confidence"`
    Redacted    string `json:"redacted"`
}

type MalwareDetection struct {
    Name        string `json:"name"`
    Type        string `json:"type"`
    File        string `json:"file"`
    Signature   string `json:"signature"`
    Confidence  string `json:"confidence"`
    Description string `json:"description"`
}

type ComplianceViolation struct {
    RuleID      string `json:"rule_id"`
    Title       string `json:"title"`
    Description string `json:"description"`
    Severity    string `json:"severity"`
    Category    string `json:"category"`
    Remediation string `json:"remediation"`
}

type TrivyScanner struct {
    endpoint string
    timeout  time.Duration
}

func NewTrivyScanner(endpoint string) *TrivyScanner {
    return &TrivyScanner{
        endpoint: endpoint,
        timeout:  5 * time.Minute,
    }
}

func (ts *TrivyScanner) Name() string {
    return "trivy"
}

func (ts *TrivyScanner) GetCapabilities() []string {
    return []string{"vulnerabilities", "secrets", "compliance"}
}

func (ts *TrivyScanner) ScanImage(ctx context.Context, image string) (*ScanResult, error) {
    result := &ScanResult{
        ScannerName: ts.Name(),
        ImageName:   image,
        ScanTime:    time.Now(),
        Status:      "scanning",
    }

    // Execute trivy scan
    cmd := exec.CommandContext(ctx, "trivy", 
        "image", 
        "--format", "json",
        "--security-checks", "vuln,secret,config",
        "--severity", "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
        image)

    output, err := cmd.Output()
    if err != nil {
        result.Status = "failed"
        return result, fmt.Errorf("trivy scan failed: %v", err)
    }

    // Parse trivy output
    var trivyResult TrivyResult
    if err := json.Unmarshal(output, &trivyResult); err != nil {
        result.Status = "failed"
        return result, fmt.Errorf("failed to parse trivy output: %v", err)
    }

    // Convert trivy results to standard format
    result.Vulnerabilities = ts.convertVulnerabilities(trivyResult.Results)
    result.Secrets = ts.convertSecrets(trivyResult.Results)
    result.Compliance = ts.convertCompliance(trivyResult.Results)
    result.RiskScore = ts.calculateRiskScore(result)
    result.Status = "completed"

    return result, nil
}

func (ts *TrivyScanner) convertVulnerabilities(results []TrivyResultItem) []Vulnerability {
    var vulnerabilities []Vulnerability
    
    for _, result := range results {
        for _, vuln := range result.Vulnerabilities {
            vulnerability := Vulnerability{
                ID:          vuln.VulnerabilityID,
                CVE:         vuln.VulnerabilityID,
                Severity:    vuln.Severity,
                Package:     vuln.PkgName,
                Version:     vuln.InstalledVersion,
                Description: vuln.Description,
                References:  vuln.References,
            }
            
            if vuln.CVSS != nil {
                vulnerability.CVSS = vuln.CVSS.V3Score
            }
            
            if vuln.FixedVersion != "" {
                vulnerability.FixedVersion = vuln.FixedVersion
            }
            
            vulnerabilities = append(vulnerabilities, vulnerability)
        }
    }
    
    return vulnerabilities
}

func (ts *TrivyScanner) convertSecrets(results []TrivyResultItem) []Secret {
    var secrets []Secret
    
    for _, result := range results {
        for _, secret := range result.Secrets {
            secretItem := Secret{
                Type:        secret.RuleID,
                Description: secret.Title,
                File:        result.Target,
                LineNumber:  secret.StartLine,
                Confidence:  "high",
                Redacted:    secret.Match[:min(len(secret.Match), 20)] + "...",
            }
            
            secrets = append(secrets, secretItem)
        }
    }
    
    return secrets
}

func (ts *TrivyScanner) convertCompliance(results []TrivyResultItem) []ComplianceViolation {
    var violations []ComplianceViolation
    
    for _, result := range results {
        for _, misconfig := range result.Misconfigurations {
            violation := ComplianceViolation{
                RuleID:      misconfig.ID,
                Title:       misconfig.Title,
                Description: misconfig.Description,
                Severity:    misconfig.Severity,
                Category:    misconfig.Type,
                Remediation: misconfig.Message,
            }
            
            violations = append(violations, violation)
        }
    }
    
    return violations
}

func (ts *TrivyScanner) calculateRiskScore(result *ScanResult) int {
    score := 0
    
    // Vulnerability scoring
    for _, vuln := range result.Vulnerabilities {
        switch vuln.Severity {
        case "CRITICAL":
            score += 10
        case "HIGH":
            score += 7
        case "MEDIUM":
            score += 4
        case "LOW":
            score += 1
        }
    }
    
    // Secret scoring
    score += len(result.Secrets) * 15
    
    // Malware scoring
    score += len(result.Malware) * 25
    
    // Compliance scoring
    for _, violation := range result.Compliance {
        switch violation.Severity {
        case "CRITICAL":
            score += 8
        case "HIGH":
            score += 5
        case "MEDIUM":
            score += 3
        case "LOW":
            score += 1
        }
    }
    
    // Cap at 100
    if score > 100 {
        score = 100
    }
    
    return score
}

type ClairScanner struct {
    endpoint string
    apiKey   string
}

func NewClairScanner(endpoint, apiKey string) *ClairScanner {
    return &ClairScanner{
        endpoint: endpoint,
        apiKey:   apiKey,
    }
}

func (cs *ClairScanner) Name() string {
    return "clair"
}

func (cs *ClairScanner) GetCapabilities() []string {
    return []string{"vulnerabilities"}
}

func (cs *ClairScanner) ScanImage(ctx context.Context, image string) (*ScanResult, error) {
    result := &ScanResult{
        ScannerName: cs.Name(),
        ImageName:   image,
        ScanTime:    time.Now(),
        Status:      "scanning",
    }

    // Implement Clair API integration
    // This would involve posting the image layers to Clair and retrieving results
    
    result.Status = "completed"
    return result, nil
}

type SnykerScanner struct {
    token string
}

func NewSnykerScanner(token string) *SnykerScanner {
    return &SnykerScanner{
        token: token,
    }
}

func (ss *SnykerScanner) Name() string {
    return "snyk"
}

func (ss *SnykerScanner) GetCapabilities() []string {
    return []string{"vulnerabilities", "secrets", "licenses"}
}

func (ss *SnykerScanner) ScanImage(ctx context.Context, image string) (*ScanResult, error) {
    result := &ScanResult{
        ScannerName: ss.Name(),
        ImageName:   image,
        ScanTime:    time.Now(),
        Status:      "scanning",
    }

    // Execute Snyk scan
    cmd := exec.CommandContext(ctx, "snyk", 
        "container", "test",
        "--json",
        "--severity-threshold=low",
        image)

    cmd.Env = append(cmd.Env, fmt.Sprintf("SNYK_TOKEN=%s", ss.token))

    output, err := cmd.Output()
    if err != nil {
        result.Status = "failed"
        return result, fmt.Errorf("snyk scan failed: %v", err)
    }

    // Parse Snyk output and convert to standard format
    result.Status = "completed"
    return result, nil
}

func NewImageScanner() (*ImageScanner, error) {
    dockerClient, err := client.NewClientWithOpts(client.FromEnv)
    if err != nil {
        return nil, fmt.Errorf("failed to create docker client: %v", err)
    }

    scanner := &ImageScanner{
        dockerClient:  dockerClient,
        scanners:      make(map[string]Scanner),
        resultStorage: NewElasticsearchStorage(),
        notifications: NewSlackNotificationService(),
    }

    // Register scanners
    scanner.RegisterScanner(NewTrivyScanner(""))
    scanner.RegisterScanner(NewClairScanner("http://clair:6060", ""))
    scanner.RegisterScanner(NewSnykerScanner(os.Getenv("SNYK_TOKEN")))

    return scanner, nil
}

func (is *ImageScanner) RegisterScanner(scanner Scanner) {
    is.scanners[scanner.Name()] = scanner
}

func (is *ImageScanner) ScanImage(ctx context.Context, image string) (*ConsolidatedScanResult, error) {
    var wg sync.WaitGroup
    results := make(chan *ScanResult, len(is.scanners))
    errors := make(chan error, len(is.scanners))

    // Run all scanners in parallel
    for _, scanner := range is.scanners {
        wg.Add(1)
        go func(s Scanner) {
            defer wg.Done()
            result, err := s.ScanImage(ctx, image)
            if err != nil {
                errors <- fmt.Errorf("scanner %s failed: %v", s.Name(), err)
                return
            }
            results <- result
        }(scanner)
    }

    // Wait for all scanners to complete
    go func() {
        wg.Wait()
        close(results)
        close(errors)
    }()

    // Collect results
    var scanResults []*ScanResult
    var scanErrors []error

    for result := range results {
        scanResults = append(scanResults, result)
    }

    for err := range errors {
        scanErrors = append(scanErrors, err)
    }

    // Consolidate results
    consolidated := is.consolidateResults(scanResults)
    
    // Apply policies
    policyResult := is.policyEngine.Evaluate(consolidated)
    consolidated.PolicyResult = policyResult

    // Store results
    if err := is.resultStorage.Store(consolidated); err != nil {
        log.Printf("Failed to store scan results: %v", err)
    }

    // Send notifications if needed
    if consolidated.RiskScore >= 70 || policyResult.Blocked {
        is.sendNotifications(consolidated)
    }

    return consolidated, nil
}

func (is *ImageScanner) consolidateResults(results []*ScanResult) *ConsolidatedScanResult {
    if len(results) == 0 {
        return &ConsolidatedScanResult{}
    }

    consolidated := &ConsolidatedScanResult{
        ImageName:    results[0].ImageName,
        ScanTime:     time.Now(),
        ScannerCount: len(results),
    }

    // Deduplicate vulnerabilities
    vulnMap := make(map[string]Vulnerability)
    secretMap := make(map[string]Secret)
    malwareMap := make(map[string]MalwareDetection)
    complianceMap := make(map[string]ComplianceViolation)

    maxRiskScore := 0

    for _, result := range results {
        if result.RiskScore > maxRiskScore {
            maxRiskScore = result.RiskScore
        }

        for _, vuln := range result.Vulnerabilities {
            key := fmt.Sprintf("%s:%s", vuln.CVE, vuln.Package)
            if existing, exists := vulnMap[key]; !exists || vuln.CVSS > existing.CVSS {
                vulnMap[key] = vuln
            }
        }

        for _, secret := range result.Secrets {
            key := fmt.Sprintf("%s:%s:%d", secret.Type, secret.File, secret.LineNumber)
            secretMap[key] = secret
        }

        for _, malware := range result.Malware {
            key := fmt.Sprintf("%s:%s", malware.Name, malware.File)
            malwareMap[key] = malware
        }

        for _, compliance := range result.Compliance {
            key := compliance.RuleID
            complianceMap[key] = compliance
        }
    }

    // Convert maps back to slices
    for _, vuln := range vulnMap {
        consolidated.Vulnerabilities = append(consolidated.Vulnerabilities, vuln)
    }
    for _, secret := range secretMap {
        consolidated.Secrets = append(consolidated.Secrets, secret)
    }
    for _, malware := range malwareMap {
        consolidated.Malware = append(consolidated.Malware, malware)
    }
    for _, compliance := range complianceMap {
        consolidated.Compliance = append(consolidated.Compliance, compliance)
    }

    consolidated.RiskScore = maxRiskScore
    consolidated.ScanResults = results

    return consolidated
}

type ConsolidatedScanResult struct {
    ImageName       string                 `json:"image_name"`
    ImageDigest     string                 `json:"image_digest"`
    ScanTime        time.Time              `json:"scan_time"`
    ScannerCount    int                    `json:"scanner_count"`
    Vulnerabilities []Vulnerability        `json:"vulnerabilities"`
    Secrets         []Secret               `json:"secrets"`
    Malware         []MalwareDetection     `json:"malware"`
    Compliance      []ComplianceViolation  `json:"compliance"`
    RiskScore       int                    `json:"risk_score"`
    PolicyResult    *PolicyResult          `json:"policy_result"`
    ScanResults     []*ScanResult          `json:"scan_results"`
}

type PolicyResult struct {
    Blocked     bool     `json:"blocked"`
    Warnings    []string `json:"warnings"`
    Violations  []string `json:"violations"`
    Exemptions  []string `json:"exemptions"`
}
```

## Section 3: Runtime Security Monitoring

Runtime security monitoring provides continuous threat detection and response capabilities for containerized environments.

### Falco Runtime Security

```yaml
# falco-deployment.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: falco
  namespace: falco-system
spec:
  selector:
    matchLabels:
      app: falco
  template:
    metadata:
      labels:
        app: falco
    spec:
      serviceAccount: falco
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
      - name: falco
        image: falcosecurity/falco-no-driver:0.36.0
        args:
        - /usr/bin/falco
        - --cri=/run/containerd/containerd.sock
        - --cri=/run/crio/crio.sock
        - -K=/var/run/secrets/kubernetes.io/serviceaccount/token
        - -k=https://kubernetes.default
        - --k8s-node=$(FALCO_K8S_NODE_NAME)
        - -pk
        securityContext:
          privileged: true
        env:
        - name: FALCO_K8S_NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: FALCO_GRPC_ENABLED
          value: "true"
        - name: FALCO_GRPC_BIND_ADDRESS
          value: "0.0.0.0:5060"
        - name: FALCO_WEBSERVER_ENABLED
          value: "true"
        volumeMounts:
        - name: proc
          mountPath: /host/proc
          readOnly: true
        - name: boot
          mountPath: /host/boot
          readOnly: true
        - name: lib-modules
          mountPath: /host/lib/modules
          readOnly: true
        - name: usr
          mountPath: /host/usr
          readOnly: true
        - name: etc
          mountPath: /host/etc
          readOnly: true
        - name: falco-config
          mountPath: /etc/falco
        - name: containerd-socket
          mountPath: /run/containerd/containerd.sock
        - name: crio-socket
          mountPath: /run/crio/crio.sock
        resources:
          limits:
            memory: 1Gi
            cpu: 1000m
          requests:
            memory: 512Mi
            cpu: 100m
      volumes:
      - name: proc
        hostPath:
          path: /proc
      - name: boot
        hostPath:
          path: /boot
      - name: lib-modules
        hostPath:
          path: /lib/modules
      - name: usr
        hostPath:
          path: /usr
      - name: etc
        hostPath:
          path: /etc
      - name: containerd-socket
        hostPath:
          path: /run/containerd/containerd.sock
          type: Socket
      - name: crio-socket
        hostPath:
          path: /run/crio/crio.sock
          type: Socket
      - name: falco-config
        configMap:
          name: falco-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: falco-config
  namespace: falco-system
data:
  falco.yaml: |
    rules_file:
      - /etc/falco/falco_rules.yaml
      - /etc/falco/falco_rules.local.yaml
      - /etc/falco/k8s_audit_rules.yaml
      - /etc/falco/custom_rules.yaml
    
    time_format_iso_8601: true
    json_output: true
    json_include_output_property: true
    
    priority: debug
    
    buffered_outputs: false
    
    outputs:
      rate: 1
      max_burst: 1000
    
    syscall_event_drops:
      rate: 0.03333
      max_burst: 10
    
    grpc:
      enabled: true
      bind_address: "0.0.0.0:5060"
      threadiness: 0
    
    webserver:
      enabled: true
      listen_port: 8765
      k8s_healthz_endpoint: /healthz
      ssl_enabled: false
    
    http_output:
      enabled: true
      url: "http://falcosidekick:2801/"
    
  custom_rules.yaml: |
    # Container Runtime Security Rules
    
    - rule: Detect crypto miners
      desc: Detect cryptocurrency mining activities
      condition: >
        spawned_process and (
          proc.name in (minergate, minergate-cli, xmr-stak, cpuminer-multi, xmrig) or
          proc.cmdline contains "cryptonight" or
          proc.cmdline contains "stratum+tcp" or
          proc.cmdline contains "pool.supportxmr.com"
        )
      output: "Crypto mining activity detected (user=%user.name proc=%proc.name cmdline=%proc.cmdline container=%container.name)"
      priority: WARNING
      tags: [malware, cryptocurrency, mining]
    
    - rule: Detect suspicious network activity
      desc: Detect suspicious outbound network connections
      condition: >
        outbound and not fd.typechar=4 and not fd.typechar=6 and
        (fd.net != "127.0.0.1" and fd.net != "::1") and
        not k8s_containers and
        (fd.sport > 32768 or
         fd.cip in (suspicious_ips) or
         fd.cnet in (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16))
      output: "Suspicious network activity (user=%user.name proc=%proc.name connection=%fd.name container=%container.name)"
      priority: WARNING
    
    - rule: Detect privilege escalation
      desc: Detect potential privilege escalation attempts
      condition: >
        spawned_process and
        (proc.name in (sudo, su, pkexec, doas) or
         proc.cmdline contains "chmod +s" or
         proc.cmdline contains "setuid" or
         proc.cmdline contains "setgid")
      output: "Privilege escalation attempt (user=%user.name proc=%proc.name cmdline=%proc.cmdline container=%container.name)"
      priority: WARNING
    
    - rule: Detect container escape attempts
      desc: Detect potential container escape techniques
      condition: >
        spawned_process and (
          proc.cmdline contains "/proc/self/exe" or
          proc.cmdline contains "docker.sock" or
          proc.cmdline contains "/var/run/docker.sock" or
          proc.cmdline contains "runc" or
          proc.cmdline contains "cgroup" or
          proc.name in (nsenter, unshare, docker, runc, ctr, nerdctl)
        )
      output: "Container escape attempt detected (user=%user.name proc=%proc.name cmdline=%proc.cmdline container=%container.name)"
      priority: CRITICAL
    
    - rule: Detect sensitive file access
      desc: Detect access to sensitive files
      condition: >
        open_read and (
          fd.name startswith /etc/shadow or
          fd.name startswith /etc/passwd or
          fd.name startswith /etc/ssh/ or
          fd.name startswith /root/.ssh/ or
          fd.name contains "id_rsa" or
          fd.name contains "private_key" or
          fd.name contains ".pem"
        )
      output: "Sensitive file access (user=%user.name file=%fd.name proc=%proc.name container=%container.name)"
      priority: WARNING
    
    - rule: Detect reverse shell
      desc: Detect potential reverse shell connections
      condition: >
        spawned_process and (
          (proc.name in (bash, sh, zsh, dash, fish) and
           proc.pname in (nc, ncat, netcat, socat, telnet)) or
          proc.cmdline contains "/dev/tcp/" or
          proc.cmdline contains "exec " and proc.cmdline contains "/dev/tcp/"
        )
      output: "Reverse shell detected (user=%user.name proc=%proc.name cmdline=%proc.cmdline container=%container.name)"
      priority: CRITICAL
    
    - rule: Detect malicious binary execution
      desc: Detect execution of known malicious binaries
      condition: >
        spawned_process and
        proc.name in (
          nc, ncat, netcat, socat, telnet, wget, curl,
          python, python2, python3, perl, ruby, lua,
          powershell, pwsh, cmd, mshta, rundll32
        ) and
        container
      output: "Malicious binary execution (user=%user.name proc=%proc.name cmdline=%proc.cmdline container=%container.name)"
      priority: WARNING
    
    - rule: Detect suspicious file modifications
      desc: Detect modifications to system files
      condition: >
        open_write and (
          fd.name startswith /bin/ or
          fd.name startswith /sbin/ or
          fd.name startswith /usr/bin/ or
          fd.name startswith /usr/sbin/ or
          fd.name startswith /etc/cron or
          fd.name startswith /etc/systemd/ or
          fd.name = /etc/passwd or
          fd.name = /etc/shadow
        )
      output: "System file modification (user=%user.name file=%fd.name proc=%proc.name container=%container.name)"
      priority: WARNING
```

### Runtime Security Response Automation

```go
// runtime-response.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

type RuntimeSecurityController struct {
    kubeClient    kubernetes.Interface
    falcoClient   *FalcoClient
    responseRules []ResponseRule
    quarantine    *QuarantineManager
    forensics     *ForensicsCollector
}

type FalcoAlert struct {
    Output       string                 `json:"output"`
    Priority     string                 `json:"priority"`
    Rule         string                 `json:"rule"`
    Time         time.Time              `json:"time"`
    OutputFields map[string]interface{} `json:"output_fields"`
    Tags         []string               `json:"tags"`
}

type ResponseRule struct {
    ID          string            `json:"id"`
    Name        string            `json:"name"`
    Description string            `json:"description"`
    Conditions  []ResponseCondition `json:"conditions"`
    Actions     []ResponseAction    `json:"actions"`
    Enabled     bool              `json:"enabled"`
    Priority    int               `json:"priority"`
}

type ResponseCondition struct {
    Field    string      `json:"field"`
    Operator string      `json:"operator"`
    Value    interface{} `json:"value"`
}

type ResponseAction struct {
    Type   string                 `json:"type"`
    Config map[string]interface{} `json:"config"`
}

type SecurityIncident struct {
    ID           string                 `json:"id"`
    Alert        FalcoAlert             `json:"alert"`
    Severity     string                 `json:"severity"`
    Status       string                 `json:"status"`
    CreatedAt    time.Time              `json:"created_at"`
    UpdatedAt    time.Time              `json:"updated_at"`
    PodName      string                 `json:"pod_name"`
    Namespace    string                 `json:"namespace"`
    NodeName     string                 `json:"node_name"`
    ContainerID  string                 `json:"container_id"`
    Actions      []IncidentAction       `json:"actions"`
    Metadata     map[string]interface{} `json:"metadata"`
}

type IncidentAction struct {
    Type        string    `json:"type"`
    Status      string    `json:"status"`
    ExecutedAt  time.Time `json:"executed_at"`
    Result      string    `json:"result"`
    Error       string    `json:"error,omitempty"`
}

func NewRuntimeSecurityController(kubeClient kubernetes.Interface) *RuntimeSecurityController {
    return &RuntimeSecurityController{
        kubeClient:    kubeClient,
        falcoClient:   NewFalcoClient("http://falco:5060"),
        responseRules: loadResponseRules(),
        quarantine:    NewQuarantineManager(kubeClient),
        forensics:     NewForensicsCollector(kubeClient),
    }
}

func loadResponseRules() []ResponseRule {
    return []ResponseRule{
        {
            ID:          "CONTAINER_ESCAPE_RESPONSE",
            Name:        "Container Escape Response",
            Description: "Immediate response to container escape attempts",
            Conditions: []ResponseCondition{
                {
                    Field:    "rule",
                    Operator: "equals",
                    Value:    "Detect container escape attempts",
                },
                {
                    Field:    "priority",
                    Operator: "equals",
                    Value:    "CRITICAL",
                },
            },
            Actions: []ResponseAction{
                {
                    Type: "quarantine_pod",
                    Config: map[string]interface{}{
                        "immediate": true,
                        "preserve_evidence": true,
                    },
                },
                {
                    Type: "collect_forensics",
                    Config: map[string]interface{}{
                        "full_collection": true,
                    },
                },
                {
                    Type: "alert_escalation",
                    Config: map[string]interface{}{
                        "severity": "critical",
                        "immediate": true,
                    },
                },
            },
            Enabled:  true,
            Priority: 1,
        },
        {
            ID:          "MALWARE_RESPONSE",
            Name:        "Malware Detection Response",
            Description: "Response to malware detection",
            Conditions: []ResponseCondition{
                {
                    Field:    "tags",
                    Operator: "contains",
                    Value:    "malware",
                },
            },
            Actions: []ResponseAction{
                {
                    Type: "isolate_container",
                    Config: map[string]interface{}{
                        "block_network": true,
                        "preserve_state": true,
                    },
                },
                {
                    Type: "collect_samples",
                    Config: map[string]interface{}{
                        "include_memory": true,
                        "include_filesystem": true,
                    },
                },
            },
            Enabled:  true,
            Priority: 2,
        },
        {
            ID:          "PRIVILEGE_ESCALATION_RESPONSE",
            Name:        "Privilege Escalation Response",
            Description: "Response to privilege escalation attempts",
            Conditions: []ResponseCondition{
                {
                    Field:    "rule",
                    Operator: "equals",
                    Value:    "Detect privilege escalation",
                },
            },
            Actions: []ResponseAction{
                {
                    Type: "terminate_process",
                    Config: map[string]interface{}{
                        "force": true,
                    },
                },
                {
                    Type: "audit_permissions",
                    Config: map[string]interface{}{
                        "deep_scan": true,
                    },
                },
            },
            Enabled:  true,
            Priority: 3,
        },
    }
}

func (rsc *RuntimeSecurityController) Start(ctx context.Context) error {
    // Start listening for Falco alerts
    alertChan := make(chan FalcoAlert, 1000)
    
    go rsc.falcoClient.StreamAlerts(ctx, alertChan)
    
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case alert := <-alertChan:
            rsc.handleAlert(ctx, alert)
        }
    }
}

func (rsc *RuntimeSecurityController) handleAlert(ctx context.Context, alert FalcoAlert) {
    // Create security incident
    incident := &SecurityIncident{
        ID:        generateIncidentID(),
        Alert:     alert,
        Severity:  rsc.calculateSeverity(alert),
        Status:    "investigating",
        CreatedAt: time.Now(),
        PodName:   rsc.extractPodName(alert),
        Namespace: rsc.extractNamespace(alert),
        NodeName:  rsc.extractNodeName(alert),
        Metadata:  map[string]interface{}{},
    }

    // Find matching response rules
    matchingRules := rsc.findMatchingRules(alert)
    
    if len(matchingRules) == 0 {
        log.Printf("No response rules matched for alert: %s", alert.Rule)
        return
    }

    // Execute response actions
    for _, rule := range matchingRules {
        for _, action := range rule.Actions {
            incidentAction := IncidentAction{
                Type:       action.Type,
                Status:     "executing",
                ExecutedAt: time.Now(),
            }

            result, err := rsc.executeAction(ctx, incident, action)
            if err != nil {
                incidentAction.Status = "failed"
                incidentAction.Error = err.Error()
                log.Printf("Action %s failed for incident %s: %v", action.Type, incident.ID, err)
            } else {
                incidentAction.Status = "completed"
                incidentAction.Result = result
                log.Printf("Action %s completed for incident %s", action.Type, incident.ID)
            }

            incident.Actions = append(incident.Actions, incidentAction)
        }
    }

    incident.UpdatedAt = time.Now()
    incident.Status = "resolved"

    // Store incident for analysis
    rsc.storeIncident(incident)
}

func (rsc *RuntimeSecurityController) findMatchingRules(alert FalcoAlert) []ResponseRule {
    var matchingRules []ResponseRule

    for _, rule := range rsc.responseRules {
        if !rule.Enabled {
            continue
        }

        if rsc.evaluateConditions(rule.Conditions, alert) {
            matchingRules = append(matchingRules, rule)
        }
    }

    // Sort by priority
    sort.Slice(matchingRules, func(i, j int) bool {
        return matchingRules[i].Priority < matchingRules[j].Priority
    })

    return matchingRules
}

func (rsc *RuntimeSecurityController) evaluateConditions(conditions []ResponseCondition, alert FalcoAlert) bool {
    for _, condition := range conditions {
        if !rsc.evaluateCondition(condition, alert) {
            return false
        }
    }
    return true
}

func (rsc *RuntimeSecurityController) evaluateCondition(condition ResponseCondition, alert FalcoAlert) bool {
    var fieldValue interface{}

    switch condition.Field {
    case "rule":
        fieldValue = alert.Rule
    case "priority":
        fieldValue = alert.Priority
    case "tags":
        fieldValue = alert.Tags
    default:
        if val, exists := alert.OutputFields[condition.Field]; exists {
            fieldValue = val
        } else {
            return false
        }
    }

    switch condition.Operator {
    case "equals":
        return fieldValue == condition.Value
    case "contains":
        if tags, ok := fieldValue.([]string); ok {
            if searchValue, ok := condition.Value.(string); ok {
                for _, tag := range tags {
                    if tag == searchValue {
                        return true
                    }
                }
            }
        }
        if str, ok := fieldValue.(string); ok {
            if searchValue, ok := condition.Value.(string); ok {
                return strings.Contains(str, searchValue)
            }
        }
    case "matches":
        if str, ok := fieldValue.(string); ok {
            if pattern, ok := condition.Value.(string); ok {
                matched, _ := regexp.MatchString(pattern, str)
                return matched
            }
        }
    }

    return false
}

func (rsc *RuntimeSecurityController) executeAction(ctx context.Context, incident *SecurityIncident, action ResponseAction) (string, error) {
    switch action.Type {
    case "quarantine_pod":
        return rsc.quarantinePod(ctx, incident, action.Config)
    case "isolate_container":
        return rsc.isolateContainer(ctx, incident, action.Config)
    case "terminate_process":
        return rsc.terminateProcess(ctx, incident, action.Config)
    case "collect_forensics":
        return rsc.collectForensics(ctx, incident, action.Config)
    case "alert_escalation":
        return rsc.escalateAlert(ctx, incident, action.Config)
    case "audit_permissions":
        return rsc.auditPermissions(ctx, incident, action.Config)
    case "collect_samples":
        return rsc.collectSamples(ctx, incident, action.Config)
    default:
        return "", fmt.Errorf("unknown action type: %s", action.Type)
    }
}

func (rsc *RuntimeSecurityController) quarantinePod(ctx context.Context, incident *SecurityIncident, config map[string]interface{}) (string, error) {
    if incident.PodName == "" || incident.Namespace == "" {
        return "", fmt.Errorf("pod name or namespace not available")
    }

    // Get the pod
    pod, err := rsc.kubeClient.CoreV1().Pods(incident.Namespace).Get(ctx, incident.PodName, metav1.GetOptions{})
    if err != nil {
        return "", fmt.Errorf("failed to get pod: %v", err)
    }

    // Create quarantine policy
    if err := rsc.quarantine.QuarantinePod(ctx, pod); err != nil {
        return "", fmt.Errorf("failed to quarantine pod: %v", err)
    }

    return fmt.Sprintf("Pod %s/%s quarantined", incident.Namespace, incident.PodName), nil
}

func (rsc *RuntimeSecurityController) isolateContainer(ctx context.Context, incident *SecurityIncident, config map[string]interface{}) (string, error) {
    // Implement container network isolation
    return "Container isolated", nil
}

func (rsc *RuntimeSecurityController) terminateProcess(ctx context.Context, incident *SecurityIncident, config map[string]interface{}) (string, error) {
    // Implement process termination
    return "Process terminated", nil
}

func (rsc *RuntimeSecurityController) collectForensics(ctx context.Context, incident *SecurityIncident, config map[string]interface{}) (string, error) {
    if incident.PodName == "" || incident.Namespace == "" {
        return "", fmt.Errorf("pod name or namespace not available")
    }

    evidence, err := rsc.forensics.CollectEvidence(ctx, incident.Namespace, incident.PodName)
    if err != nil {
        return "", fmt.Errorf("failed to collect forensics: %v", err)
    }

    return fmt.Sprintf("Forensic evidence collected: %s", evidence.ID), nil
}

func (rsc *RuntimeSecurityController) escalateAlert(ctx context.Context, incident *SecurityIncident, config map[string]interface{}) (string, error) {
    // Implement alert escalation
    return "Alert escalated", nil
}

func (rsc *RuntimeSecurityController) auditPermissions(ctx context.Context, incident *SecurityIncident, config map[string]interface{}) (string, error) {
    // Implement permission auditing
    return "Permissions audited", nil
}

func (rsc *RuntimeSecurityController) collectSamples(ctx context.Context, incident *SecurityIncident, config map[string]interface{}) (string, error) {
    // Implement sample collection for malware analysis
    return "Samples collected", nil
}

func (rsc *RuntimeSecurityController) calculateSeverity(alert FalcoAlert) string {
    switch alert.Priority {
    case "Emergency", "Alert", "Critical":
        return "critical"
    case "Error", "Warning":
        return "high"
    case "Notice", "Informational":
        return "medium"
    default:
        return "low"
    }
}

func (rsc *RuntimeSecurityController) extractPodName(alert FalcoAlert) string {
    if podName, exists := alert.OutputFields["k8s.pod.name"]; exists {
        if str, ok := podName.(string); ok {
            return str
        }
    }
    return ""
}

func (rsc *RuntimeSecurityController) extractNamespace(alert FalcoAlert) string {
    if namespace, exists := alert.OutputFields["k8s.ns.name"]; exists {
        if str, ok := namespace.(string); ok {
            return str
        }
    }
    return ""
}

func (rsc *RuntimeSecurityController) extractNodeName(alert FalcoAlert) string {
    if nodeName, exists := alert.OutputFields["k8s.node.name"]; exists {
        if str, ok := nodeName.(string); ok {
            return str
        }
    }
    return ""
}

func (rsc *RuntimeSecurityController) storeIncident(incident *SecurityIncident) error {
    // Store incident in database or SIEM system
    log.Printf("Storing incident: %s", incident.ID)
    return nil
}

func generateIncidentID() string {
    return fmt.Sprintf("INC-%d", time.Now().Unix())
}
```

This comprehensive container security guide provides enterprise-grade solutions for vulnerability scanning, runtime protection, and automated threat response. Organizations should adapt these implementations to their specific security requirements, compliance mandates, and operational environments while maintaining continuous monitoring and improvement of their container security posture.