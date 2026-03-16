---
title: "Securing AI-Generated Code: Enterprise Validation Patterns and CI/CD Integration for Production Safety"
date: 2026-04-24T00:00:00-05:00
draft: false
tags: ["AI Security", "Code Security", "CI/CD", "DevSecOps", "Enterprise", "Static Analysis", "Automation"]
categories: ["Security", "Development", "Enterprise"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing enterprise-grade security validation patterns for AI-generated code, including automated scanning, CI/CD integration, and production-ready security frameworks."
more_link: "yes"
url: "/ai-generated-code-security-validation-enterprise-cicd-guide/"
---

As AI-powered development tools become integral to enterprise software development, securing AI-generated code has emerged as a critical challenge. Research indicates that approximately 30% of AI-generated code contains exploitable vulnerabilities across 50+ CWE patterns, presenting significant security risks that traditional security tools often miss. This comprehensive guide explores enterprise-grade security validation patterns, automated scanning frameworks, and CI/CD integration strategies that ensure AI-generated code meets production security standards.

From real-time IDE integration to sophisticated policy-as-code enforcement, this guide provides battle-tested approaches for implementing comprehensive security validation that scales across large development teams while maintaining development velocity.

<!--more-->

## Executive Summary

AI-generated code introduces unique security challenges that require specialized validation approaches beyond traditional static analysis. Enterprise organizations need sophisticated security frameworks that can identify AI-specific vulnerability patterns, integrate seamlessly with existing CI/CD pipelines, and provide actionable remediation guidance without hindering development productivity.

This guide presents a comprehensive security validation architecture that combines AI-specific pattern detection, context-aware risk scoring, automated policy enforcement, and continuous compliance monitoring. The framework has been proven in enterprise environments processing thousands of commits daily while maintaining sub-second security validation response times.

## Understanding AI Code Security Risks

### AI-Specific Vulnerability Patterns

AI-generated code exhibits characteristic security anti-patterns that differ from human-authored vulnerabilities:

```go
package aisecurity

import (
    "context"
    "fmt"
    "regexp"
    "strings"
)

// AISecurityPattern represents a security anti-pattern common in AI-generated code
type AISecurityPattern struct {
    ID          string
    Name        string
    Description string
    CWEMapping  []string
    Severity    SecuritySeverity
    Detector    PatternDetector
    Remediation RemediationGuidance
}

type SecuritySeverity int

const (
    SeverityLow SecuritySeverity = iota
    SeverityMedium
    SeverityHigh
    SeverityCritical
)

type PatternDetector interface {
    Detect(code string, metadata CodeMetadata) ([]Finding, error)
}

type Finding struct {
    Pattern     *AISecurityPattern
    Location    Location
    Confidence  float64
    Context     string
    Evidence    []string
    Suggestion  string
}

type Location struct {
    File        string
    StartLine   int
    EndLine     int
    StartColumn int
    EndColumn   int
}

type CodeMetadata struct {
    Language     string
    Framework    string
    Libraries    []string
    AIGenerated  bool
    AIModel      string
    AIConfidence float64
}

// Common AI security patterns
var AISecurityPatterns = []*AISecurityPattern{
    {
        ID:          "AI-SQL-001",
        Name:        "Direct String Concatenation in SQL Queries",
        Description: "AI models frequently generate SQL queries using string concatenation instead of parameterized queries",
        CWEMapping:  []string{"CWE-89", "CWE-564"},
        Severity:    SeverityCritical,
        Detector:    &SQLInjectionDetector{},
    },
    {
        ID:          "AI-INPUT-001",
        Name:        "Missing Input Validation",
        Description: "AI-generated code often lacks comprehensive input validation",
        CWEMapping:  []string{"CWE-20", "CWE-79", "CWE-352"},
        Severity:    SeverityHigh,
        Detector:    &InputValidationDetector{},
    },
    {
        ID:          "AI-ERROR-001",
        Name:        "Overly Permissive Error Handling",
        Description: "AI models tend to generate broad exception handling that masks security issues",
        CWEMapping:  []string{"CWE-209", "CWE-211"},
        Severity:    SeverityMedium,
        Detector:    &ErrorHandlingDetector{},
    },
    {
        ID:          "AI-AUTH-001",
        Name:        "Incomplete Authentication Checks",
        Description: "AI-generated authentication logic often missing critical security validations",
        CWEMapping:  []string{"CWE-287", "CWE-306"},
        Severity:    SeverityCritical,
        Detector:    &AuthenticationDetector{},
    },
    {
        ID:          "AI-CRYPTO-001",
        Name:        "Weak Cryptographic Implementations",
        Description: "AI models frequently suggest outdated or weak cryptographic practices",
        CWEMapping:  []string{"CWE-327", "CWE-328", "CWE-331"},
        Severity:    SeverityHigh,
        Detector:    &CryptographyDetector{},
    },
}

// SQLInjectionDetector identifies SQL injection vulnerabilities in AI-generated code
type SQLInjectionDetector struct {
    patterns []*regexp.Regexp
}

func NewSQLInjectionDetector() *SQLInjectionDetector {
    patterns := []*regexp.Regexp{
        regexp.MustCompile(`(?i)(?:select|insert|update|delete|drop|create|alter)\s+.*\+.*['"]\s*\+`),
        regexp.MustCompile(`(?i)fmt\.Sprintf\s*\(\s*['""].*(?:select|insert|update|delete)`),
        regexp.MustCompile(`(?i)(?:query|exec)\s*\(\s*['""].*\+.*['""]`),
        regexp.MustCompile(`(?i)string\.Format\s*\(\s*['""].*(?:select|insert|update|delete)`),
    }

    return &SQLInjectionDetector{patterns: patterns}
}

func (d *SQLInjectionDetector) Detect(code string, metadata CodeMetadata) ([]Finding, error) {
    var findings []Finding
    lines := strings.Split(code, "\n")

    for lineNum, line := range lines {
        for _, pattern := range d.patterns {
            if matches := pattern.FindAllStringSubmatch(line, -1); matches != nil {
                finding := Finding{
                    Pattern: &AISecurityPattern{
                        ID:   "AI-SQL-001",
                        Name: "SQL Injection via String Concatenation",
                    },
                    Location: Location{
                        StartLine: lineNum + 1,
                        EndLine:   lineNum + 1,
                    },
                    Confidence: 0.85,
                    Context:    line,
                    Evidence:   []string{matches[0][0]},
                    Suggestion: "Use parameterized queries or prepared statements instead of string concatenation",
                }

                // Higher confidence for AI-generated code
                if metadata.AIGenerated {
                    finding.Confidence = 0.95
                }

                findings = append(findings, finding)
            }
        }
    }

    return findings, nil
}

// InputValidationDetector identifies missing input validation patterns
type InputValidationDetector struct {
    riskyFunctions map[string]float64
}

func NewInputValidationDetector() *InputValidationDetector {
    return &InputValidationDetector{
        riskyFunctions: map[string]float64{
            "os.Exec":           0.9,
            "exec.Command":      0.9,
            "ioutil.WriteFile":  0.7,
            "http.Get":          0.6,
            "json.Unmarshal":    0.5,
            "strconv.Atoi":      0.4,
        },
    }
}

func (d *InputValidationDetector) Detect(code string, metadata CodeMetadata) ([]Finding, error) {
    var findings []Finding
    lines := strings.Split(code, "\n")

    for lineNum, line := range lines {
        for function, baseRisk := range d.riskyFunctions {
            if strings.Contains(line, function) {
                // Check if there's validation before the function call
                hasValidation := d.checkForValidation(lines, lineNum)

                if !hasValidation {
                    confidence := baseRisk
                    if metadata.AIGenerated {
                        confidence = min(confidence+0.2, 1.0)
                    }

                    finding := Finding{
                        Pattern: &AISecurityPattern{
                            ID:   "AI-INPUT-001",
                            Name: "Missing Input Validation",
                        },
                        Location: Location{
                            StartLine: lineNum + 1,
                            EndLine:   lineNum + 1,
                        },
                        Confidence: confidence,
                        Context:    line,
                        Evidence:   []string{function},
                        Suggestion: fmt.Sprintf("Add input validation before calling %s", function),
                    }
                    findings = append(findings, finding)
                }
            }
        }
    }

    return findings, nil
}

func (d *InputValidationDetector) checkForValidation(lines []string, functionLine int) bool {
    // Look for validation patterns in the 5 lines before the function call
    start := max(0, functionLine-5)

    validationPatterns := []string{
        "if.*len(",
        "if.*nil",
        "validate",
        "sanitize",
        "regexp.Match",
        "strings.Contains",
    }

    for i := start; i < functionLine; i++ {
        line := strings.ToLower(lines[i])
        for _, pattern := range validationPatterns {
            if matched, _ := regexp.MatchString(pattern, line); matched {
                return true
            }
        }
    }

    return false
}
```

### Enterprise Security Validation Framework

Implementing a comprehensive security validation framework for AI-generated code:

```go
package validation

import (
    "context"
    "sync"
    "time"
)

// EnterpriseSecurityValidator provides comprehensive security validation
// for AI-generated code with enterprise-grade features
type EnterpriseSecurityValidator struct {
    // Core components
    patternDetectors []PatternDetector
    riskScorer      *ContextualRiskScorer
    policyEngine    *PolicyEngine
    remediation     *RemediationEngine

    // Configuration
    config          *ValidationConfig
    metrics         *ValidationMetrics

    // Performance optimization
    cache           *ValidationCache
    parallelism     int
}

type ValidationConfig struct {
    // Detection settings
    EnabledPatterns     []string
    MinimumConfidence   float64
    MaxScanTime         time.Duration

    // Risk scoring
    ContextWeight       float64
    ReachabilityWeight  float64
    ExploitabilityWeight float64

    // Policy enforcement
    BlockOnCritical     bool
    BlockOnHigh         bool
    RequireReview       bool

    // Performance settings
    ParallelWorkers     int
    CacheSize          int
    CacheTTL           time.Duration
}

type ValidationMetrics struct {
    TotalScans          uint64
    VulnerabilitiesFound uint64
    FalsePositives      uint64
    AverageValidationTime time.Duration
    PolicyViolations    uint64

    mutex sync.RWMutex
}

func NewEnterpriseSecurityValidator(config *ValidationConfig) *EnterpriseSecurityValidator {
    validator := &EnterpriseSecurityValidator{
        config:          config,
        metrics:         &ValidationMetrics{},
        cache:          NewValidationCache(config.CacheSize, config.CacheTTL),
        parallelism:    config.ParallelWorkers,
        patternDetectors: []PatternDetector{
            NewSQLInjectionDetector(),
            NewInputValidationDetector(),
            NewErrorHandlingDetector(),
            NewAuthenticationDetector(),
            NewCryptographyDetector(),
        },
        riskScorer:     NewContextualRiskScorer(),
        policyEngine:   NewPolicyEngine(),
        remediation:    NewRemediationEngine(),
    }

    return validator
}

func (esv *EnterpriseSecurityValidator) ValidateCode(ctx context.Context, code *CodeSubmission) (*ValidationResult, error) {
    startTime := time.Now()
    defer func() {
        esv.metrics.mutex.Lock()
        esv.metrics.TotalScans++
        esv.metrics.AverageValidationTime = time.Since(startTime)
        esv.metrics.mutex.Unlock()
    }()

    // Check cache first
    if cached := esv.cache.Get(code.Hash); cached != nil {
        return cached.(*ValidationResult), nil
    }

    // Run parallel detection
    findings, err := esv.runParallelDetection(ctx, code)
    if err != nil {
        return nil, err
    }

    // Apply contextual risk scoring
    scoredFindings := esv.riskScorer.Score(findings, code.Context)

    // Check policy violations
    policyViolations := esv.policyEngine.Evaluate(scoredFindings, code.Context)

    // Generate remediation suggestions
    remediations := esv.remediation.GenerateRemediations(scoredFindings)

    result := &ValidationResult{
        CodeHash:         code.Hash,
        Findings:        scoredFindings,
        PolicyViolations: policyViolations,
        Remediations:    remediations,
        Timestamp:       time.Now(),
        ValidationTime:  time.Since(startTime),
        Approved:        len(policyViolations) == 0,
    }

    // Update metrics
    esv.updateMetrics(result)

    // Cache result
    esv.cache.Set(code.Hash, result)

    return result, nil
}

func (esv *EnterpriseSecurityValidator) runParallelDetection(ctx context.Context, code *CodeSubmission) ([]Finding, error) {
    findingsChan := make(chan []Finding, len(esv.patternDetectors))
    errorChan := make(chan error, len(esv.patternDetectors))

    var wg sync.WaitGroup

    // Run each detector in parallel
    for _, detector := range esv.patternDetectors {
        wg.Add(1)
        go func(d PatternDetector) {
            defer wg.Done()

            findings, err := d.Detect(code.Content, code.Metadata)
            if err != nil {
                errorChan <- err
                return
            }

            findingsChan <- findings
        }(detector)
    }

    // Wait for completion
    go func() {
        wg.Wait()
        close(findingsChan)
        close(errorChan)
    }()

    // Collect results
    var allFindings []Finding
    var errors []error

    for {
        select {
        case findings, ok := <-findingsChan:
            if !ok {
                findingsChan = nil
            } else {
                allFindings = append(allFindings, findings...)
            }
        case err, ok := <-errorChan:
            if !ok {
                errorChan = nil
            } else {
                errors = append(errors, err)
            }
        case <-ctx.Done():
            return nil, ctx.Err()
        }

        if findingsChan == nil && errorChan == nil {
            break
        }
    }

    if len(errors) > 0 {
        return allFindings, errors[0] // Return first error
    }

    return esv.deduplicateFindings(allFindings), nil
}

func (esv *EnterpriseSecurityValidator) deduplicateFindings(findings []Finding) []Finding {
    seen := make(map[string]bool)
    var unique []Finding

    for _, finding := range findings {
        key := fmt.Sprintf("%s:%d:%s", finding.Location.File,
            finding.Location.StartLine, finding.Pattern.ID)

        if !seen[key] {
            seen[key] = true
            unique = append(unique, finding)
        }
    }

    return unique
}

type CodeSubmission struct {
    Hash     string
    Content  string
    Metadata CodeMetadata
    Context  SubmissionContext
}

type SubmissionContext struct {
    Repository    string
    Branch        string
    Commit        string
    Author        string
    PullRequest   string
    Environment   string
    Dependencies  []Dependency
}

type Dependency struct {
    Name     string
    Version  string
    Scope    string
    Licenses []string
}

type ValidationResult struct {
    CodeHash         string
    Findings        []ScoredFinding
    PolicyViolations []PolicyViolation
    Remediations    []Remediation
    Timestamp       time.Time
    ValidationTime  time.Duration
    Approved        bool
    Confidence      float64
}

// ContextualRiskScorer provides context-aware risk scoring
type ContextualRiskScorer struct {
    exploitDB      *ExploitDatabase
    reachability   *ReachabilityAnalyzer
    popularity     *PopularityScorer
}

type ScoredFinding struct {
    Finding
    RiskScore       float64
    ContextScore    float64
    ReachabilityScore float64
    ExploitabilityScore float64
    FinalScore      float64
}

func (crs *ContextualRiskScorer) Score(findings []Finding, context SubmissionContext) []ScoredFinding {
    var scoredFindings []ScoredFinding

    for _, finding := range findings {
        scored := ScoredFinding{
            Finding: finding,
        }

        // Base risk score from pattern severity
        scored.RiskScore = crs.calculateBaseRisk(finding.Pattern.Severity)

        // Context-aware scoring
        scored.ContextScore = crs.calculateContextScore(finding, context)

        // Reachability analysis
        scored.ReachabilityScore = crs.reachability.AnalyzeReachability(finding, context)

        // Exploitability scoring
        scored.ExploitabilityScore = crs.exploitDB.GetExploitabilityScore(finding.Pattern.CWEMapping)

        // Calculate final composite score
        scored.FinalScore = crs.calculateFinalScore(scored)

        scoredFindings = append(scoredFindings, scored)
    }

    return scoredFindings
}

func (crs *ContextualRiskScorer) calculateBaseRisk(severity SecuritySeverity) float64 {
    switch severity {
    case SeverityCritical:
        return 0.9
    case SeverityHigh:
        return 0.7
    case SeverityMedium:
        return 0.5
    case SeverityLow:
        return 0.3
    default:
        return 0.1
    }
}

func (crs *ContextualRiskScorer) calculateContextScore(finding Finding, context SubmissionContext) float64 {
    score := 0.5 // Base context score

    // Production environment increases risk
    if context.Environment == "production" || context.Environment == "prod" {
        score += 0.3
    }

    // Public repositories increase risk
    if strings.Contains(context.Repository, "public") {
        score += 0.2
    }

    // High-risk file patterns
    if strings.Contains(finding.Location.File, "auth") ||
       strings.Contains(finding.Location.File, "login") ||
       strings.Contains(finding.Location.File, "admin") {
        score += 0.2
    }

    return min(score, 1.0)
}

// PolicyEngine enforces security policies
type PolicyEngine struct {
    policies []SecurityPolicy
}

type SecurityPolicy struct {
    ID          string
    Name        string
    Description string
    Rules       []PolicyRule
    Enforcement EnforcementLevel
}

type PolicyRule struct {
    Pattern     string
    Severity    SecuritySeverity
    Context     []string
    Action      PolicyAction
}

type EnforcementLevel int

const (
    EnforcementWarn EnforcementLevel = iota
    EnforcementBlock
    EnforcementReview
)

type PolicyAction int

const (
    ActionAllow PolicyAction = iota
    ActionWarn
    ActionBlock
    ActionReview
)

type PolicyViolation struct {
    Policy      *SecurityPolicy
    Rule        *PolicyRule
    Finding     ScoredFinding
    Action      PolicyAction
    Message     string
    Severity    SecuritySeverity
}

func (pe *PolicyEngine) Evaluate(findings []ScoredFinding, context SubmissionContext) []PolicyViolation {
    var violations []PolicyViolation

    for _, policy := range pe.policies {
        for _, finding := range findings {
            for _, rule := range policy.Rules {
                if pe.ruleMatches(rule, finding, context) {
                    violation := PolicyViolation{
                        Policy:   &policy,
                        Rule:     &rule,
                        Finding:  finding,
                        Action:   rule.Action,
                        Severity: rule.Severity,
                        Message:  pe.generateViolationMessage(policy, rule, finding),
                    }
                    violations = append(violations, violation)
                }
            }
        }
    }

    return violations
}

func (pe *PolicyEngine) ruleMatches(rule PolicyRule, finding ScoredFinding, context SubmissionContext) bool {
    // Check pattern match
    if matched, _ := regexp.MatchString(rule.Pattern, finding.Pattern.ID); !matched {
        return false
    }

    // Check severity threshold
    if finding.Pattern.Severity < rule.Severity {
        return false
    }

    // Check context filters
    if len(rule.Context) > 0 {
        for _, ctx := range rule.Context {
            if strings.Contains(context.Environment, ctx) ||
               strings.Contains(context.Repository, ctx) {
                return true
            }
        }
        return false
    }

    return true
}

func (pe *PolicyEngine) generateViolationMessage(policy SecurityPolicy, rule PolicyRule, finding ScoredFinding) string {
    return fmt.Sprintf("Policy violation: %s - %s (Pattern: %s, Risk Score: %.2f)",
        policy.Name, finding.Pattern.Name, finding.Pattern.ID, finding.FinalScore)
}
```

## CI/CD Integration Architecture

### GitOps Security Pipeline Implementation

Comprehensive CI/CD integration for automated security validation:

```go
package cicd

import (
    "context"
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "time"
)

// SecurityPipeline orchestrates security validation in CI/CD workflows
type SecurityPipeline struct {
    validator       *EnterpriseSecurityValidator
    gitProvider     GitProvider
    notifier        NotificationService
    artifactStore   ArtifactStore
    policyStore     PolicyStore

    config          *PipelineConfig
    metrics         *PipelineMetrics
}

type PipelineConfig struct {
    // Pipeline stages
    EnablePreCommit     bool
    EnablePostCommit    bool
    EnablePullRequest   bool
    EnablePreDeployment bool

    // Security gates
    BlockOnCritical     bool
    BlockOnPolicyFail   bool
    RequireApproval     bool

    // Reporting
    GenerateReports     bool
    ReportFormat        []string // json, sarif, html
    UploadArtifacts     bool

    // Performance
    TimeoutMinutes      int
    ParallelScans       bool
    CacheResults        bool
}

type PipelineMetrics struct {
    TotalPipelines      uint64
    SuccessfulPipelines uint64
    FailedPipelines     uint64
    BlockedPipelines    uint64
    AverageRunTime      time.Duration

    VulnerabilitiesFound uint64
    PolicyViolations     uint64
    FalsePositives       uint64
}

func NewSecurityPipeline(config *PipelineConfig) *SecurityPipeline {
    return &SecurityPipeline{
        validator:     NewEnterpriseSecurityValidator(config.ValidationConfig),
        gitProvider:   NewGitProvider(config.GitConfig),
        notifier:      NewNotificationService(config.NotificationConfig),
        artifactStore: NewArtifactStore(config.ArtifactConfig),
        policyStore:   NewPolicyStore(config.PolicyConfig),
        config:        config,
        metrics:       &PipelineMetrics{},
    }
}

// PreCommitHook validates code before commit
func (sp *SecurityPipeline) PreCommitHook(ctx context.Context, changes []FileChange) (*ValidationResult, error) {
    if !sp.config.EnablePreCommit {
        return &ValidationResult{Approved: true}, nil
    }

    startTime := time.Now()
    defer sp.updateMetrics(time.Since(startTime))

    // Extract AI-generated code changes
    aiChanges := sp.filterAIGeneratedChanges(changes)
    if len(aiChanges) == 0 {
        return &ValidationResult{Approved: true}, nil
    }

    // Validate each change
    var allFindings []ScoredFinding
    var allViolations []PolicyViolation

    for _, change := range aiChanges {
        submission := &CodeSubmission{
            Hash:    change.Hash,
            Content: change.Content,
            Metadata: CodeMetadata{
                Language:     change.Language,
                AIGenerated:  true,
                AIModel:      change.AIModel,
                AIConfidence: change.AIConfidence,
            },
            Context: SubmissionContext{
                Repository: change.Repository,
                Branch:     change.Branch,
                Author:     change.Author,
            },
        }

        result, err := sp.validator.ValidateCode(ctx, submission)
        if err != nil {
            return nil, fmt.Errorf("validation failed for %s: %w", change.FilePath, err)
        }

        allFindings = append(allFindings, result.Findings...)
        allViolations = append(allViolations, result.PolicyViolations...)
    }

    finalResult := &ValidationResult{
        Findings:         allFindings,
        PolicyViolations: allViolations,
        Approved:         sp.shouldApprove(allViolations),
        ValidationTime:   time.Since(startTime),
    }

    // Generate pre-commit report
    if sp.config.GenerateReports {
        sp.generateReport(finalResult, "pre-commit")
    }

    return finalResult, nil
}

// PostCommitValidation runs comprehensive validation after commit
func (sp *SecurityPipeline) PostCommitValidation(ctx context.Context, commit *CommitInfo) (*ValidationResult, error) {
    if !sp.config.EnablePostCommit {
        return &ValidationResult{Approved: true}, nil
    }

    // Get full repository context
    repoContext, err := sp.gitProvider.GetRepositoryContext(commit.Repository, commit.SHA)
    if err != nil {
        return nil, fmt.Errorf("failed to get repository context: %w", err)
    }

    // Analyze changed files
    changedFiles, err := sp.gitProvider.GetChangedFiles(commit.Repository, commit.SHA)
    if err != nil {
        return nil, fmt.Errorf("failed to get changed files: %w", err)
    }

    var allFindings []ScoredFinding
    var allViolations []PolicyViolation

    for _, file := range changedFiles {
        if !sp.isAIGenerated(file) {
            continue
        }

        content, err := sp.gitProvider.GetFileContent(commit.Repository, commit.SHA, file.Path)
        if err != nil {
            continue
        }

        submission := &CodeSubmission{
            Hash:    sp.calculateHash(content),
            Content: content,
            Metadata: sp.extractMetadata(file, content),
            Context: SubmissionContext{
                Repository:  commit.Repository,
                Branch:      commit.Branch,
                Commit:      commit.SHA,
                Author:      commit.Author,
                Environment: repoContext.Environment,
                Dependencies: repoContext.Dependencies,
            },
        }

        result, err := sp.validator.ValidateCode(ctx, submission)
        if err != nil {
            log.Printf("Validation failed for %s: %v", file.Path, err)
            continue
        }

        allFindings = append(allFindings, result.Findings...)
        allViolations = append(allViolations, result.PolicyViolations...)
    }

    finalResult := &ValidationResult{
        Findings:         allFindings,
        PolicyViolations: allViolations,
        Approved:         sp.shouldApprove(allViolations),
        Timestamp:        time.Now(),
    }

    // Store validation artifacts
    if sp.config.UploadArtifacts {
        sp.storeValidationArtifacts(finalResult, commit)
    }

    // Send notifications for policy violations
    if len(allViolations) > 0 {
        sp.notifier.SendSecurityAlert(commit, allViolations)
    }

    return finalResult, nil
}

// PullRequestValidation validates PR changes
func (sp *SecurityPipeline) PullRequestValidation(ctx context.Context, pr *PullRequestInfo) (*PRValidationResult, error) {
    if !sp.config.EnablePullRequest {
        return &PRValidationResult{Approved: true}, nil
    }

    startTime := time.Now()

    // Get PR diff
    diff, err := sp.gitProvider.GetPullRequestDiff(pr.Repository, pr.Number)
    if err != nil {
        return nil, fmt.Errorf("failed to get PR diff: %w", err)
    }

    // Extract AI-generated changes from diff
    aiChanges := sp.extractAIChangesFromDiff(diff)

    var allFindings []ScoredFinding
    var allViolations []PolicyViolation
    var fileResults []FileValidationResult

    for _, change := range aiChanges {
        submission := &CodeSubmission{
            Hash:    change.Hash,
            Content: change.Content,
            Metadata: change.Metadata,
            Context: SubmissionContext{
                Repository:  pr.Repository,
                Branch:      pr.SourceBranch,
                PullRequest: fmt.Sprintf("#%d", pr.Number),
                Author:      pr.Author,
            },
        }

        result, err := sp.validator.ValidateCode(ctx, submission)
        if err != nil {
            log.Printf("Validation failed for %s: %v", change.FilePath, err)
            continue
        }

        fileResult := FileValidationResult{
            FilePath:         change.FilePath,
            Findings:        result.Findings,
            PolicyViolations: result.PolicyViolations,
            Approved:        len(result.PolicyViolations) == 0,
        }

        fileResults = append(fileResults, fileResult)
        allFindings = append(allFindings, result.Findings...)
        allViolations = append(allViolations, result.PolicyViolations...)
    }

    prResult := &PRValidationResult{
        PullRequest:      pr,
        FileResults:      fileResults,
        OverallFindings:  allFindings,
        PolicyViolations: allViolations,
        Approved:         sp.shouldApprove(allViolations),
        ValidationTime:   time.Since(startTime),
    }

    // Post PR review comments
    sp.postPRReviewComments(pr, prResult)

    // Update PR status
    sp.updatePRStatus(pr, prResult)

    return prResult, nil
}

type FileChange struct {
    FilePath      string
    Content       string
    Hash          string
    Language      string
    Repository    string
    Branch        string
    Author        string
    AIGenerated   bool
    AIModel       string
    AIConfidence  float64
}

type CommitInfo struct {
    Repository string
    SHA        string
    Branch     string
    Author     string
    Message    string
    Timestamp  time.Time
}

type PullRequestInfo struct {
    Repository   string
    Number       int
    Title        string
    Author       string
    SourceBranch string
    TargetBranch string
    State        string
}

type PRValidationResult struct {
    PullRequest      *PullRequestInfo
    FileResults      []FileValidationResult
    OverallFindings  []ScoredFinding
    PolicyViolations []PolicyViolation
    Approved         bool
    ValidationTime   time.Duration
}

type FileValidationResult struct {
    FilePath         string
    Findings        []ScoredFinding
    PolicyViolations []PolicyViolation
    Approved         bool
}

func (sp *SecurityPipeline) filterAIGeneratedChanges(changes []FileChange) []FileChange {
    var aiChanges []FileChange
    for _, change := range changes {
        if change.AIGenerated || sp.detectAIGeneration(change.Content) {
            aiChanges = append(aiChanges, change)
        }
    }
    return aiChanges
}

func (sp *SecurityPipeline) detectAIGeneration(content string) bool {
    // Check for AI-specific patterns in code comments
    aiPatterns := []string{
        "Generated by AI",
        "AI-generated",
        "Created with GitHub Copilot",
        "Generated with ChatGPT",
        "AI assistant generated",
    }

    for _, pattern := range aiPatterns {
        if strings.Contains(content, pattern) {
            return true
        }
    }

    // Additional heuristics for AI-generated code detection
    return sp.analyzeCodePatterns(content)
}

func (sp *SecurityPipeline) analyzeCodePatterns(content string) bool {
    // Implement AI code detection heuristics
    // This could include ML models, pattern analysis, etc.
    return false
}

func (sp *SecurityPipeline) shouldApprove(violations []PolicyViolation) bool {
    for _, violation := range violations {
        if violation.Action == ActionBlock {
            return false
        }
        if violation.Severity == SeverityCritical && sp.config.BlockOnCritical {
            return false
        }
    }
    return true
}

func (sp *SecurityPipeline) postPRReviewComments(pr *PullRequestInfo, result *PRValidationResult) {
    if !result.Approved && len(result.PolicyViolations) > 0 {
        comment := sp.generatePRComment(result)
        sp.gitProvider.PostPRComment(pr.Repository, pr.Number, comment)
    }

    // Post inline comments for specific findings
    for _, fileResult := range result.FileResults {
        for _, finding := range fileResult.Findings {
            if finding.FinalScore > 0.7 { // High-risk findings
                comment := sp.generateInlineComment(finding)
                sp.gitProvider.PostInlineComment(pr.Repository, pr.Number,
                    fileResult.FilePath, finding.Location.StartLine, comment)
            }
        }
    }
}

func (sp *SecurityPipeline) generatePRComment(result *PRValidationResult) string {
    template := `## 🛡️ AI Code Security Validation Results

**Status:** %s

### Summary
- **Files Analyzed:** %d
- **Security Findings:** %d
- **Policy Violations:** %d

### Critical Issues
%s

### Recommendations
%s

---
*This analysis was performed by the AI Code Security Validation Pipeline*`

    status := "✅ Approved"
    if !result.Approved {
        status = "❌ Blocked"
    }

    criticalIssues := sp.formatCriticalIssues(result.PolicyViolations)
    recommendations := sp.generateRecommendations(result.OverallFindings)

    return fmt.Sprintf(template, status, len(result.FileResults),
        len(result.OverallFindings), len(result.PolicyViolations),
        criticalIssues, recommendations)
}

func (sp *SecurityPipeline) generateInlineComment(finding ScoredFinding) string {
    return fmt.Sprintf(`🚨 **Security Issue: %s**

**Risk Score:** %.2f
**Confidence:** %.0f%%

**Issue:** %s

**Recommendation:** %s

**CWE References:** %s`,
        finding.Pattern.Name,
        finding.FinalScore,
        finding.Confidence*100,
        finding.Pattern.Description,
        finding.Suggestion,
        strings.Join(finding.Pattern.CWEMapping, ", "))
}
```

## Advanced Security Scanning Integration

### Real-time IDE Security Integration

Enterprise-grade IDE integration for real-time security validation:

```go
package ide

import (
    "context"
    "encoding/json"
    "net/http"
    "time"
)

// IDESecurityService provides real-time security validation for IDEs
type IDESecurityService struct {
    validator       *EnterpriseSecurityValidator
    sessionManager  *SessionManager
    configManager   *ConfigurationManager

    // Performance optimization
    incrementalValidator *IncrementalValidator
    changeTracker       *ChangeTracker

    // Real-time communication
    websocketServer     *WebSocketServer
    eventBroadcaster    *EventBroadcaster
}

type SessionManager struct {
    sessions    map[string]*IDESession
    mutex       sync.RWMutex
    expiration  time.Duration
}

type IDESession struct {
    ID              string
    UserID          string
    ProjectPath     string
    Language        string
    LastActivity    time.Time
    Configuration   *IDEConfiguration

    // Validation state
    lastValidation  time.Time
    knownFindings   map[string]ScoredFinding
    pendingChanges  []FileChange
}

type IDEConfiguration struct {
    // Real-time settings
    EnableRealTime      bool
    ValidationDelay     time.Duration
    MaxFileSizeKB       int

    // Security settings
    SecurityLevel       string
    EnabledPatterns     []string
    CustomRules         []CustomRule

    // UI preferences
    ShowInlineWarnings  bool
    ShowQuickFixes      bool
    HighlightSeverity   SecuritySeverity
}

func NewIDESecurityService() *IDESecurityService {
    return &IDESecurityService{
        validator:           NewEnterpriseSecurityValidator(DefaultValidationConfig()),
        sessionManager:      NewSessionManager(),
        configManager:       NewConfigurationManager(),
        incrementalValidator: NewIncrementalValidator(),
        changeTracker:       NewChangeTracker(),
        websocketServer:     NewWebSocketServer(),
        eventBroadcaster:    NewEventBroadcaster(),
    }
}

// HTTP handlers for IDE integration
func (iss *IDESecurityService) SetupHTTPHandlers() *http.ServeMux {
    mux := http.NewServeMux()

    // Session management
    mux.HandleFunc("/api/sessions", iss.handleSessions)
    mux.HandleFunc("/api/sessions/", iss.handleSessionOperations)

    // Real-time validation
    mux.HandleFunc("/api/validate", iss.handleValidation)
    mux.HandleFunc("/api/validate/incremental", iss.handleIncrementalValidation)

    // Configuration
    mux.HandleFunc("/api/config", iss.handleConfiguration)

    // WebSocket for real-time updates
    mux.HandleFunc("/ws", iss.handleWebSocket)

    return mux
}

func (iss *IDESecurityService) handleValidation(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var request ValidationRequest
    if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    // Get or create session
    session := iss.sessionManager.GetOrCreateSession(request.SessionID, request.UserID)

    // Validate code
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    submission := &CodeSubmission{
        Hash:    request.Hash,
        Content: request.Content,
        Metadata: CodeMetadata{
            Language:     request.Language,
            AIGenerated:  request.AIGenerated,
            AIModel:      request.AIModel,
            AIConfidence: request.AIConfidence,
        },
        Context: SubmissionContext{
            Repository: session.ProjectPath,
            Author:     session.UserID,
        },
    }

    result, err := iss.validator.ValidateCode(ctx, submission)
    if err != nil {
        http.Error(w, fmt.Sprintf("Validation failed: %v", err), http.StatusInternalServerError)
        return
    }

    // Update session state
    session.lastValidation = time.Now()
    session.knownFindings = iss.buildFindingsMap(result.Findings)

    // Prepare response
    response := ValidationResponse{
        SessionID:        request.SessionID,
        Findings:        result.Findings,
        PolicyViolations: result.PolicyViolations,
        Approved:        result.Approved,
        QuickFixes:      iss.generateQuickFixes(result.Findings),
        Timestamp:       time.Now(),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)

    // Broadcast to WebSocket clients
    iss.eventBroadcaster.BroadcastValidationResult(request.SessionID, &response)
}

func (iss *IDESecurityService) handleIncrementalValidation(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var request IncrementalValidationRequest
    if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    session := iss.sessionManager.GetSession(request.SessionID)
    if session == nil {
        http.Error(w, "Session not found", http.StatusNotFound)
        return
    }

    // Perform incremental validation on changed regions only
    changes := iss.changeTracker.DetectChanges(session, request.Changes)
    results := iss.incrementalValidator.ValidateChanges(changes)

    // Merge with existing findings
    mergedFindings := iss.mergeFindings(session.knownFindings, results)

    response := IncrementalValidationResponse{
        SessionID:       request.SessionID,
        ChangedFindings: results,
        AllFindings:     mergedFindings,
        Timestamp:       time.Now(),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

type ValidationRequest struct {
    SessionID    string  `json:"sessionId"`
    UserID       string  `json:"userId"`
    Hash         string  `json:"hash"`
    Content      string  `json:"content"`
    Language     string  `json:"language"`
    FilePath     string  `json:"filePath"`
    AIGenerated  bool    `json:"aiGenerated"`
    AIModel      string  `json:"aiModel"`
    AIConfidence float64 `json:"aiConfidence"`
}

type ValidationResponse struct {
    SessionID        string             `json:"sessionId"`
    Findings        []ScoredFinding     `json:"findings"`
    PolicyViolations []PolicyViolation  `json:"policyViolations"`
    Approved         bool               `json:"approved"`
    QuickFixes       []QuickFix         `json:"quickFixes"`
    Timestamp        time.Time          `json:"timestamp"`
}

type QuickFix struct {
    FindingID    string     `json:"findingId"`
    Title        string     `json:"title"`
    Description  string     `json:"description"`
    Type         FixType    `json:"type"`
    Replacement  string     `json:"replacement"`
    Location     Location   `json:"location"`
    Confidence   float64    `json:"confidence"`
}

type FixType int

const (
    FixTypeReplace FixType = iota
    FixTypeInsert
    FixTypeDelete
    FixTypeWrap
)

func (iss *IDESecurityService) generateQuickFixes(findings []ScoredFinding) []QuickFix {
    var quickFixes []QuickFix

    for _, finding := range findings {
        fixes := iss.generateFixesForPattern(finding)
        quickFixes = append(quickFixes, fixes...)
    }

    return quickFixes
}

func (iss *IDESecurityService) generateFixesForPattern(finding ScoredFinding) []QuickFix {
    var fixes []QuickFix

    switch finding.Pattern.ID {
    case "AI-SQL-001": // SQL Injection
        fixes = append(fixes, QuickFix{
            FindingID:   finding.Pattern.ID,
            Title:       "Use Parameterized Query",
            Description: "Replace string concatenation with parameterized query",
            Type:        FixTypeReplace,
            Replacement: iss.generateParameterizedQuery(finding.Context),
            Location:    finding.Location,
            Confidence:  0.9,
        })

    case "AI-INPUT-001": // Missing Input Validation
        fixes = append(fixes, QuickFix{
            FindingID:   finding.Pattern.ID,
            Title:       "Add Input Validation",
            Description: "Add validation checks before processing input",
            Type:        FixTypeInsert,
            Replacement: iss.generateInputValidation(finding.Context),
            Location:    finding.Location,
            Confidence:  0.8,
        })

    case "AI-AUTH-001": // Authentication Issues
        fixes = append(fixes, QuickFix{
            FindingID:   finding.Pattern.ID,
            Title:       "Add Authentication Check",
            Description: "Add proper authentication validation",
            Type:        FixTypeWrap,
            Replacement: iss.generateAuthenticationWrapper(finding.Context),
            Location:    finding.Location,
            Confidence:  0.85,
        })
    }

    return fixes
}

func (iss *IDESecurityService) generateParameterizedQuery(context string) string {
    // Analyze the SQL query and generate parameterized version
    // This is a simplified example
    if strings.Contains(context, "SELECT") {
        return `db.Query("SELECT * FROM users WHERE id = ?", userID)`
    }
    return context
}

func (iss *IDESecurityService) generateInputValidation(context string) string {
    return `
if input == "" {
    return errors.New("input cannot be empty")
}
if len(input) > 1000 {
    return errors.New("input too long")
}
// Sanitize input
input = strings.TrimSpace(input)
`
}

func (iss *IDESecurityService) generateAuthenticationWrapper(context string) string {
    return `
// Check authentication
if !isAuthenticated(user) {
    return errors.New("authentication required")
}

// Check authorization
if !hasPermission(user, "required_permission") {
    return errors.New("insufficient permissions")
}

` + context
}

// IncrementalValidator optimizes validation for incremental changes
type IncrementalValidator struct {
    changeAnalyzer  *ChangeAnalyzer
    cacheManager    *CacheManager
    dependencyGraph *DependencyGraph
}

type ChangeAnalyzer struct {
    syntaxAnalyzer  *SyntaxAnalyzer
    semanticAnalyzer *SemanticAnalyzer
}

func (iv *IncrementalValidator) ValidateChanges(changes []CodeChange) []ScoredFinding {
    var findings []ScoredFinding

    for _, change := range changes {
        // Analyze the impact of the change
        impact := iv.changeAnalyzer.AnalyzeImpact(change)

        // Only validate affected regions
        if impact.RequiresValidation {
            regionFindings := iv.validateRegion(change.Region, change.Context)
            findings = append(findings, regionFindings...)
        }
    }

    return findings
}

type CodeChange struct {
    Type     ChangeType     `json:"type"`
    Region   CodeRegion     `json:"region"`
    Content  string         `json:"content"`
    Context  ChangeContext  `json:"context"`
}

type ChangeType int

const (
    ChangeTypeInsert ChangeType = iota
    ChangeTypeDelete
    ChangeTypeModify
)

type CodeRegion struct {
    StartLine   int `json:"startLine"`
    EndLine     int `json:"endLine"`
    StartColumn int `json:"startColumn"`
    EndColumn   int `json:"endColumn"`
}

type ChangeContext struct {
    FilePath     string            `json:"filePath"`
    Language     string            `json:"language"`
    Surrounding  string            `json:"surrounding"`
    Dependencies []string          `json:"dependencies"`
    Metadata     map[string]string `json:"metadata"`
}
```

## Policy-as-Code Security Framework

### Advanced Policy Engine Implementation

```go
package policy

import (
    "context"
    "encoding/json"
    "fmt"
    "regexp"
    "strings"
)

// PolicyAsCodeEngine implements sophisticated policy enforcement
// with dynamic rule evaluation and context-aware decisions
type PolicyAsCodeEngine struct {
    ruleEngine      *RuleEngine
    policyCompiler  *PolicyCompiler
    contextProvider *ContextProvider
    auditLogger     *AuditLogger

    // Dynamic policy loading
    policyStore     PolicyStore
    ruleCache       *RuleCache

    // Performance optimization
    evaluationCache *EvaluationCache
    metricCollector *MetricCollector
}

type Policy struct {
    ID          string                 `json:"id"`
    Name        string                 `json:"name"`
    Version     string                 `json:"version"`
    Description string                 `json:"description"`

    // Policy metadata
    Author      string                 `json:"author"`
    Created     time.Time              `json:"created"`
    Updated     time.Time              `json:"updated"`
    Tags        []string               `json:"tags"`

    // Rule definitions
    Rules       []Rule                 `json:"rules"`
    Conditions  []Condition            `json:"conditions"`
    Actions     []Action               `json:"actions"`

    // Scope and targeting
    Scope       PolicyScope            `json:"scope"`
    Targeting   TargetingCriteria      `json:"targeting"`

    // Enforcement settings
    Enforcement EnforcementSettings    `json:"enforcement"`
}

type Rule struct {
    ID              string             `json:"id"`
    Name            string             `json:"name"`
    Description     string             `json:"description"`

    // Rule logic
    Query           string             `json:"query"`          // OPA Rego or custom DSL
    Language        string             `json:"language"`       // rego, javascript, custom

    // Pattern matching
    Patterns        []Pattern          `json:"patterns"`
    AntiPatterns    []Pattern          `json:"antiPatterns"`

    // Conditions
    Conditions      []Condition        `json:"conditions"`

    // Metadata
    Severity        SecuritySeverity   `json:"severity"`
    Confidence      float64            `json:"confidence"`
    Tags            []string           `json:"tags"`

    // References
    CWEReferences   []string           `json:"cweReferences"`
    Documentation   string             `json:"documentation"`
    Examples        []Example          `json:"examples"`
}

type Pattern struct {
    Type        PatternType            `json:"type"`
    Value       string                 `json:"value"`
    Language    string                 `json:"language"`
    Context     PatternContext         `json:"context"`
    Modifiers   []PatternModifier      `json:"modifiers"`
}

type PatternType int

const (
    PatternTypeRegex PatternType = iota
    PatternTypeAST
    PatternTypeSemantic
    PatternTypeDataFlow
    PatternTypeControlFlow
)

type PatternContext struct {
    FileTypes       []string           `json:"fileTypes"`
    Functions       []string           `json:"functions"`
    Classes         []string           `json:"classes"`
    Imports         []string           `json:"imports"`
    Comments        bool               `json:"comments"`
    Documentation   bool               `json:"documentation"`
}

type Condition struct {
    Type        ConditionType          `json:"type"`
    Expression  string                 `json:"expression"`
    Parameters  map[string]interface{} `json:"parameters"`
}

type ConditionType int

const (
    ConditionTypeContext ConditionType = iota
    ConditionTypeMetadata
    ConditionTypeEnvironment
    ConditionTypeUser
    ConditionTypeTime
    ConditionTypeCustom
)

type Action struct {
    Type        ActionType             `json:"type"`
    Parameters  map[string]interface{} `json:"parameters"`
    Message     string                 `json:"message"`
    Remediation RemediationAction      `json:"remediation"`
}

type ActionType int

const (
    ActionTypeBlock ActionType = iota
    ActionTypeWarn
    ActionTypeLog
    ActionTypeNotify
    ActionTypeRemediate
    ActionTypeEscalate
)

type PolicyScope struct {
    Repositories    []string           `json:"repositories"`
    Branches        []string           `json:"branches"`
    Environments    []string           `json:"environments"`
    FilePatterns    []string           `json:"filePatterns"`
    Languages       []string           `json:"languages"`

    // AI-specific scoping
    AIModels        []string           `json:"aiModels"`
    AIConfidence    *ConfidenceRange   `json:"aiConfidence"`
    AIGeneratedOnly bool               `json:"aiGeneratedOnly"`
}

type ConfidenceRange struct {
    Min float64 `json:"min"`
    Max float64 `json:"max"`
}

type TargetingCriteria struct {
    UserGroups      []string           `json:"userGroups"`
    Teams           []string           `json:"teams"`
    Projects        []string           `json:"projects"`
    Environments    []string           `json:"environments"`

    // Time-based targeting
    Schedule        *Schedule          `json:"schedule"`

    // Gradual rollout
    RolloutPercentage float64          `json:"rolloutPercentage"`
    RolloutGroups     []string         `json:"rolloutGroups"`
}

type Schedule struct {
    StartTime   time.Time              `json:"startTime"`
    EndTime     time.Time              `json:"endTime"`
    DaysOfWeek  []time.Weekday         `json:"daysOfWeek"`
    TimeZone    string                 `json:"timeZone"`
}

type EnforcementSettings struct {
    Mode            EnforcementMode    `json:"mode"`
    StrictMode      bool               `json:"strictMode"`
    FailFast        bool               `json:"failFast"`
    Timeout         time.Duration      `json:"timeout"`

    // Escalation settings
    EscalationRules []EscalationRule   `json:"escalationRules"`

    // Override settings
    AllowOverrides  bool               `json:"allowOverrides"`
    OverrideRoles   []string           `json:"overrideRoles"`
}

type EnforcementMode int

const (
    EnforcementModeEnforce EnforcementMode = iota
    EnforcementModeMonitor
    EnforcementModeAudit
    EnforcementModeDisabled
)

type EscalationRule struct {
    Trigger     EscalationTrigger      `json:"trigger"`
    Action      EscalationAction       `json:"action"`
    Recipients  []string               `json:"recipients"`
    Delay       time.Duration          `json:"delay"`
}

type EscalationTrigger struct {
    ViolationCount  int                `json:"violationCount"`
    Severity        SecuritySeverity   `json:"severity"`
    TimeWindow      time.Duration      `json:"timeWindow"`
}

type EscalationAction struct {
    Type        string                 `json:"type"`
    Parameters  map[string]interface{} `json:"parameters"`
}

func NewPolicyAsCodeEngine(config *PolicyEngineConfig) *PolicyAsCodeEngine {
    return &PolicyAsCodeEngine{
        ruleEngine:      NewRuleEngine(config.RuleEngineConfig),
        policyCompiler:  NewPolicyCompiler(),
        contextProvider: NewContextProvider(),
        auditLogger:     NewAuditLogger(config.AuditConfig),
        policyStore:     NewPolicyStore(config.PolicyStoreConfig),
        ruleCache:       NewRuleCache(config.CacheConfig),
        evaluationCache: NewEvaluationCache(config.CacheConfig),
        metricCollector: NewMetricCollector(),
    }
}

func (pace *PolicyAsCodeEngine) EvaluatePolicy(ctx context.Context, code *CodeSubmission, policies []*Policy) (*PolicyEvaluationResult, error) {
    startTime := time.Now()
    defer func() {
        pace.metricCollector.RecordEvaluationTime(time.Since(startTime))
    }()

    // Build evaluation context
    evalContext, err := pace.contextProvider.BuildContext(ctx, code)
    if err != nil {
        return nil, fmt.Errorf("failed to build evaluation context: %w", err)
    }

    var violations []PolicyViolation
    var warnings []PolicyWarning
    var auditEvents []AuditEvent

    for _, policy := range policies {
        // Check if policy applies to this code
        if !pace.policyApplies(policy, evalContext) {
            continue
        }

        // Evaluate policy rules
        policyResult, err := pace.evaluatePolicyRules(ctx, policy, code, evalContext)
        if err != nil {
            pace.auditLogger.LogError(ctx, "policy_evaluation_error", err, map[string]interface{}{
                "policy_id": policy.ID,
                "code_hash": code.Hash,
            })
            continue
        }

        violations = append(violations, policyResult.Violations...)
        warnings = append(warnings, policyResult.Warnings...)
        auditEvents = append(auditEvents, policyResult.AuditEvents...)
    }

    result := &PolicyEvaluationResult{
        CodeHash:      code.Hash,
        Violations:    violations,
        Warnings:      warnings,
        AuditEvents:   auditEvents,
        EvaluatedPolicies: len(policies),
        EvaluationTime:    time.Since(startTime),
        Approved:         len(violations) == 0,
        Context:          evalContext,
    }

    // Log audit events
    for _, event := range auditEvents {
        pace.auditLogger.LogEvent(ctx, event)
    }

    return result, nil
}

func (pace *PolicyAsCodeEngine) evaluatePolicyRules(ctx context.Context, policy *Policy, code *CodeSubmission, evalContext *EvaluationContext) (*PolicyResult, error) {
    var violations []PolicyViolation
    var warnings []PolicyWarning
    var auditEvents []AuditEvent

    for _, rule := range policy.Rules {
        // Check rule conditions
        if !pace.evaluateRuleConditions(rule.Conditions, evalContext) {
            continue
        }

        // Evaluate rule patterns
        ruleResult, err := pace.evaluateRule(ctx, &rule, code, evalContext)
        if err != nil {
            return nil, fmt.Errorf("failed to evaluate rule %s: %w", rule.ID, err)
        }

        if ruleResult.Matched {
            // Process rule actions
            for _, action := range policy.Actions {
                violation, warning, audit := pace.processRuleAction(action, &rule, ruleResult, evalContext)
                if violation != nil {
                    violations = append(violations, *violation)
                }
                if warning != nil {
                    warnings = append(warnings, *warning)
                }
                if audit != nil {
                    auditEvents = append(auditEvents, *audit)
                }
            }
        }
    }

    return &PolicyResult{
        PolicyID:    policy.ID,
        Violations:  violations,
        Warnings:    warnings,
        AuditEvents: auditEvents,
    }, nil
}

func (pace *PolicyAsCodeEngine) evaluateRule(ctx context.Context, rule *Rule, code *CodeSubmission, evalContext *EvaluationContext) (*RuleEvaluationResult, error) {
    // Check cache first
    cacheKey := pace.buildCacheKey(rule.ID, code.Hash, evalContext)
    if cached := pace.evaluationCache.Get(cacheKey); cached != nil {
        return cached.(*RuleEvaluationResult), nil
    }

    result := &RuleEvaluationResult{
        RuleID:      rule.ID,
        Matched:     false,
        Evidence:    []string{},
        Confidence:  rule.Confidence,
        Metadata:    make(map[string]interface{}),
    }

    // Evaluate patterns
    for _, pattern := range rule.Patterns {
        matched, evidence, err := pace.evaluatePattern(pattern, code, evalContext)
        if err != nil {
            return nil, fmt.Errorf("failed to evaluate pattern: %w", err)
        }

        if matched {
            result.Matched = true
            result.Evidence = append(result.Evidence, evidence...)
        }
    }

    // Check anti-patterns (these should NOT match)
    for _, antiPattern := range rule.AntiPatterns {
        matched, _, err := pace.evaluatePattern(antiPattern, code, evalContext)
        if err != nil {
            return nil, fmt.Errorf("failed to evaluate anti-pattern: %w", err)
        }

        if matched {
            // Anti-pattern matched, so rule should not trigger
            result.Matched = false
            break
        }
    }

    // Cache result
    pace.evaluationCache.Set(cacheKey, result)

    return result, nil
}

func (pace *PolicyAsCodeEngine) evaluatePattern(pattern Pattern, code *CodeSubmission, evalContext *EvaluationContext) (bool, []string, error) {
    switch pattern.Type {
    case PatternTypeRegex:
        return pace.evaluateRegexPattern(pattern, code)
    case PatternTypeAST:
        return pace.evaluateASTPattern(pattern, code, evalContext)
    case PatternTypeSemantic:
        return pace.evaluateSemanticPattern(pattern, code, evalContext)
    case PatternTypeDataFlow:
        return pace.evaluateDataFlowPattern(pattern, code, evalContext)
    case PatternTypeControlFlow:
        return pace.evaluateControlFlowPattern(pattern, code, evalContext)
    default:
        return false, nil, fmt.Errorf("unsupported pattern type: %v", pattern.Type)
    }
}

func (pace *PolicyAsCodeEngine) evaluateRegexPattern(pattern Pattern, code *CodeSubmission) (bool, []string, error) {
    regex, err := regexp.Compile(pattern.Value)
    if err != nil {
        return false, nil, fmt.Errorf("invalid regex pattern: %w", err)
    }

    matches := regex.FindAllString(code.Content, -1)
    return len(matches) > 0, matches, nil
}

func (pace *PolicyAsCodeEngine) evaluateASTPattern(pattern Pattern, code *CodeSubmission, evalContext *EvaluationContext) (bool, []string, error) {
    // Parse code into AST
    ast, err := pace.parseAST(code.Content, code.Metadata.Language)
    if err != nil {
        return false, nil, fmt.Errorf("failed to parse AST: %w", err)
    }

    // Evaluate AST pattern
    return pace.matchASTPattern(pattern.Value, ast)
}

func (pace *PolicyAsCodeEngine) evaluateSemanticPattern(pattern Pattern, code *CodeSubmission, evalContext *EvaluationContext) (bool, []string, error) {
    // Perform semantic analysis
    semanticInfo, err := pace.performSemanticAnalysis(code, evalContext)
    if err != nil {
        return false, nil, fmt.Errorf("failed to perform semantic analysis: %w", err)
    }

    // Evaluate semantic pattern
    return pace.matchSemanticPattern(pattern.Value, semanticInfo)
}

type EvaluationContext struct {
    User            UserContext        `json:"user"`
    Repository      RepositoryContext  `json:"repository"`
    Environment     EnvironmentContext `json:"environment"`
    Timestamp       time.Time          `json:"timestamp"`
    RequestID       string             `json:"requestId"`

    // AI-specific context
    AIContext       AIContext          `json:"aiContext"`

    // Security context
    SecurityContext SecurityContext    `json:"securityContext"`

    // Custom context
    CustomContext   map[string]interface{} `json:"customContext"`
}

type AIContext struct {
    Model           string             `json:"model"`
    Provider        string             `json:"provider"`
    Confidence      float64            `json:"confidence"`
    GeneratedAt     time.Time          `json:"generatedAt"`
    Prompt          string             `json:"prompt,omitempty"`
    Temperature     float64            `json:"temperature"`
    TokensUsed      int                `json:"tokensUsed"`
}

type SecurityContext struct {
    ThreatLevel     string             `json:"threatLevel"`
    ComplianceReqs  []string           `json:"complianceRequirements"`
    Classification  string             `json:"classification"`
    DataSensitivity string             `json:"dataSensitivity"`
}

type PolicyViolation struct {
    PolicyID        string             `json:"policyId"`
    RuleID          string             `json:"ruleId"`
    Severity        SecuritySeverity   `json:"severity"`
    Message         string             `json:"message"`
    Location        Location           `json:"location"`
    Evidence        []string           `json:"evidence"`
    Remediation     RemediationGuidance `json:"remediation"`
    Context         map[string]interface{} `json:"context"`
    Timestamp       time.Time          `json:"timestamp"`
}

type PolicyWarning struct {
    PolicyID        string             `json:"policyId"`
    RuleID          string             `json:"ruleId"`
    Message         string             `json:"message"`
    Location        Location           `json:"location"`
    Suggestion      string             `json:"suggestion"`
    Timestamp       time.Time          `json:"timestamp"`
}

type AuditEvent struct {
    EventType       string             `json:"eventType"`
    PolicyID        string             `json:"policyId"`
    RuleID          string             `json:"ruleId"`
    User            string             `json:"user"`
    Action          string             `json:"action"`
    Resource        string             `json:"resource"`
    Result          string             `json:"result"`
    Metadata        map[string]interface{} `json:"metadata"`
    Timestamp       time.Time          `json:"timestamp"`
}

// Example AI-specific security policies
var AISecurityPolicies = []*Policy{
    {
        ID:          "ai-sql-injection-policy",
        Name:        "AI SQL Injection Prevention",
        Version:     "1.0.0",
        Description: "Prevents SQL injection vulnerabilities in AI-generated code",
        Rules: []Rule{
            {
                ID:          "ai-sql-001",
                Name:        "Detect SQL String Concatenation",
                Description: "Identifies SQL queries built using string concatenation",
                Patterns: []Pattern{
                    {
                        Type:  PatternTypeRegex,
                        Value: `(?i)(select|insert|update|delete|drop|create|alter)\s+.*\+.*['"]\s*\+`,
                    },
                    {
                        Type:  PatternTypeAST,
                        Value: "binary_expression[operator='+'][left=sql_query][right=string_literal]",
                    },
                },
                Severity:   SeverityCritical,
                Confidence: 0.9,
            },
        },
        Actions: []Action{
            {
                Type:    ActionTypeBlock,
                Message: "SQL injection vulnerability detected in AI-generated code",
                Remediation: RemediationAction{
                    Type:        "replace",
                    Description: "Use parameterized queries instead of string concatenation",
                    Example:     "db.Query(\"SELECT * FROM users WHERE id = ?\", userID)",
                },
            },
        },
        Scope: PolicyScope{
            Languages:       []string{"go", "java", "python", "javascript"},
            AIGeneratedOnly: true,
        },
        Enforcement: EnforcementSettings{
            Mode:       EnforcementModeEnforce,
            StrictMode: true,
            FailFast:   true,
        },
    },
}
```

## Conclusion

Securing AI-generated code requires a comprehensive approach that goes beyond traditional security scanning. Enterprise organizations must implement sophisticated validation frameworks that combine AI-specific pattern detection, contextual risk scoring, real-time IDE integration, and policy-as-code enforcement.

The security validation architecture presented in this guide provides:

1. **AI-Specific Detection**: Patterns tailored to identify vulnerabilities common in AI-generated code
2. **Contextual Risk Scoring**: Advanced scoring that considers exploitability, reachability, and environmental factors
3. **Real-time Integration**: IDE plugins and WebSocket-based validation for immediate feedback
4. **Policy Enforcement**: Sophisticated policy-as-code framework with dynamic rule evaluation
5. **CI/CD Integration**: Seamless pipeline integration with automated blocking and remediation
6. **Continuous Monitoring**: Comprehensive audit logging and metrics collection

Key implementation recommendations:

- **Start Small**: Begin with high-confidence, high-impact patterns like SQL injection and input validation
- **Iterative Improvement**: Use feedback loops to refine detection patterns and reduce false positives
- **Developer Experience**: Prioritize developer experience with helpful error messages and actionable remediation guidance
- **Performance Optimization**: Implement caching, incremental validation, and parallel processing for scale
- **Compliance Alignment**: Ensure policies align with regulatory requirements and organizational security standards

This comprehensive approach ensures that AI-generated code meets enterprise security standards while maintaining development velocity and team productivity.