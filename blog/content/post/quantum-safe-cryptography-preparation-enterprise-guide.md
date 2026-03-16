---
title: "Quantum-Safe Cryptography Preparation: Enterprise Infrastructure Protection Guide"
date: 2026-11-01T00:00:00-05:00
draft: false
tags: ["Quantum Computing", "Cryptography", "Post-Quantum Cryptography", "PQC", "Security", "TLS", "PKI", "Enterprise Security"]
categories: ["Security", "Cryptography", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to preparing enterprise infrastructure for quantum-safe cryptography, including PQC algorithm implementation, hybrid cryptography strategies, and migration planning for post-quantum security."
more_link: "yes"
url: "/quantum-safe-cryptography-preparation-enterprise-guide/"
---

Enterprise organizations face an emerging threat from quantum computers capable of breaking current cryptographic algorithms. This comprehensive guide covers quantum-safe cryptography preparation, including post-quantum cryptographic (PQC) algorithm implementation, hybrid cryptography strategies, and complete migration planning for enterprise infrastructure.

<!--more-->

# Quantum-Safe Cryptography Preparation: Enterprise Infrastructure Protection Guide

## Executive Summary

Quantum computers pose a significant threat to current cryptographic systems. Organizations must begin preparing now for post-quantum cryptography (PQC) to protect sensitive data from future quantum attacks. This guide provides practical implementation strategies for quantum-safe cryptography in enterprise environments.

## Understanding the Quantum Threat

### Current Cryptographic Vulnerabilities

**RSA and ECC Weaknesses:**
```go
// Current vulnerable cryptographic operations
package crypto

import (
    "crypto/rsa"
    "crypto/ecdsa"
    "crypto/elliptic"
    "crypto/rand"
    "crypto/x509"
    "encoding/pem"
    "fmt"
)

// VulnerableKeyGeneration demonstrates current algorithms vulnerable to quantum attacks
type VulnerableKeyGeneration struct {
    RSAKeySize int
    ECCCurve   elliptic.Curve
}

func (v *VulnerableKeyGeneration) GenerateRSAKey() (*rsa.PrivateKey, error) {
    // RSA-2048 and RSA-4096 are vulnerable to Shor's algorithm on quantum computers
    privateKey, err := rsa.GenerateKey(rand.Reader, v.RSAKeySize)
    if err != nil {
        return nil, fmt.Errorf("failed to generate RSA key: %w", err)
    }

    fmt.Printf("WARNING: Generated RSA-%d key vulnerable to quantum attacks\n", v.RSAKeySize)
    return privateKey, nil
}

func (v *VulnerableKeyGeneration) GenerateECCKey() (*ecdsa.PrivateKey, error) {
    // ECC algorithms (P-256, P-384, P-521) are vulnerable to quantum attacks
    privateKey, err := ecdsa.GenerateKey(v.ECCCurve, rand.Reader)
    if err != nil {
        return nil, fmt.Errorf("failed to generate ECC key: %w", err)
    }

    fmt.Println("WARNING: Generated ECC key vulnerable to quantum attacks")
    return privateKey, nil
}

// QuantumThreatAnalysis assesses quantum vulnerability
type QuantumThreatAnalysis struct {
    Algorithm       string
    KeySize         int
    QuantumBits     int
    YearsToBreak    float64
    HarvestRisk     bool
}

func AnalyzeQuantumThreat(algorithm string, keySize int) *QuantumThreatAnalysis {
    analysis := &QuantumThreatAnalysis{
        Algorithm: algorithm,
        KeySize:   keySize,
    }

    switch algorithm {
    case "RSA":
        // Shor's algorithm: O(n^3) classical operations, O(n) qubits needed
        analysis.QuantumBits = keySize
        analysis.YearsToBreak = estimateRSABreakingTime(keySize)
        analysis.HarvestRisk = true

    case "ECC":
        // Modified Shor's algorithm for elliptic curves
        analysis.QuantumBits = keySize * 2
        analysis.YearsToBreak = estimateECCBreakingTime(keySize)
        analysis.HarvestRisk = true

    case "AES":
        // Grover's algorithm: reduces effective key size by half
        analysis.QuantumBits = keySize / 2
        analysis.YearsToBreak = estimateAESBreakingTime(keySize)
        analysis.HarvestRisk = keySize < 256
    }

    return analysis
}

func estimateRSABreakingTime(keySize int) float64 {
    // Conservative estimates based on quantum computing progress
    switch {
    case keySize <= 2048:
        return 5.0 // 5 years with mature quantum computers
    case keySize <= 3072:
        return 10.0
    case keySize <= 4096:
        return 15.0
    default:
        return 20.0
    }
}

func estimateECCBreakingTime(keySize int) float64 {
    // ECC is more vulnerable than RSA to quantum attacks
    switch {
    case keySize <= 256:
        return 3.0
    case keySize <= 384:
        return 7.0
    case keySize <= 521:
        return 12.0
    default:
        return 15.0
    }
}

func estimateAESBreakingTime(keySize int) float64 {
    // AES with Grover's algorithm resistance
    switch keySize {
    case 128:
        return 50.0 // AES-128 becomes effectively 64-bit security
    case 192:
        return 100.0
    case 256:
        return 200.0 // AES-256 remains secure
    default:
        return 0.0
    }
}
```

### Harvest Now, Decrypt Later (HNDL) Attacks

**Data Collection Threat:**
```yaml
# threat-model.yaml
apiVersion: security.quantum.io/v1
kind: QuantumThreatModel
metadata:
  name: hndl-threat-assessment
  namespace: security
spec:
  threatScenario:
    name: "Harvest Now, Decrypt Later"
    description: "Adversaries collecting encrypted data today to decrypt with future quantum computers"

  vulnerableAssets:
    - name: "TLS Traffic"
      protocol: "TLS 1.2/1.3"
      keyExchange: "RSA-2048, ECDHE-P256"
      threatLevel: "CRITICAL"
      dataRetentionValue: "10+ years"

    - name: "Encrypted Backups"
      encryption: "AES-128-CBC with RSA key wrap"
      threatLevel: "HIGH"
      dataRetentionValue: "7+ years"

    - name: "VPN Communications"
      protocol: "IPSec with RSA/ECC"
      threatLevel: "HIGH"
      dataRetentionValue: "5+ years"

    - name: "Email Encryption"
      protocol: "S/MIME with RSA-2048"
      threatLevel: "CRITICAL"
      dataRetentionValue: "Indefinite"

    - name: "Code Signing"
      algorithm: "RSA-2048, ECDSA-P256"
      threatLevel: "MEDIUM"
      dataRetentionValue: "Software lifetime"

  mitigationTimeline:
    phase1:
      name: "Assessment"
      duration: "6 months"
      actions:
        - "Inventory cryptographic systems"
        - "Identify high-value data"
        - "Assess quantum timeline"

    phase2:
      name: "Testing"
      duration: "12 months"
      actions:
        - "Deploy PQC in test environments"
        - "Performance benchmarking"
        - "Interoperability testing"

    phase3:
      name: "Hybrid Deployment"
      duration: "18 months"
      actions:
        - "Implement hybrid PQC/classical"
        - "Gradual production rollout"
        - "Monitor and optimize"

    phase4:
      name: "Full Migration"
      duration: "24 months"
      actions:
        - "Complete PQC deployment"
        - "Decommission classical crypto"
        - "Continuous monitoring"
```

## NIST Post-Quantum Cryptography Standards

### Selected PQC Algorithms

**NIST PQC Standards Overview:**
```go
// pqc_algorithms.go
package pqc

import (
    "fmt"
    "time"
)

// NISTAlgorithm represents a NIST-selected PQC algorithm
type NISTAlgorithm struct {
    Name            string
    Category        string
    SecurityLevel   int
    KeySize         int
    SignatureSize   int
    CiphertextSize  int
    Performance     PerformanceMetrics
    StandardStatus  string
}

type PerformanceMetrics struct {
    KeyGenTime    time.Duration
    SignTime      time.Duration
    VerifyTime    time.Duration
    EncryptTime   time.Duration
    DecryptTime   time.Duration
}

// GetNISTAlgorithms returns the NIST-selected PQC algorithms
func GetNISTAlgorithms() []NISTAlgorithm {
    return []NISTAlgorithm{
        {
            Name:           "CRYSTALS-Kyber",
            Category:       "Key Encapsulation Mechanism (KEM)",
            SecurityLevel:  3,
            KeySize:        2400,
            CiphertextSize: 1568,
            Performance: PerformanceMetrics{
                KeyGenTime:  50 * time.Microsecond,
                EncryptTime: 70 * time.Microsecond,
                DecryptTime: 80 * time.Microsecond,
            },
            StandardStatus: "FIPS 203 (2024)",
        },
        {
            Name:           "CRYSTALS-Dilithium",
            Category:       "Digital Signature",
            SecurityLevel:  3,
            KeySize:        2592,
            SignatureSize:  3309,
            Performance: PerformanceMetrics{
                KeyGenTime: 100 * time.Microsecond,
                SignTime:   200 * time.Microsecond,
                VerifyTime: 100 * time.Microsecond,
            },
            StandardStatus: "FIPS 204 (2024)",
        },
        {
            Name:           "FALCON",
            Category:       "Digital Signature",
            SecurityLevel:  5,
            KeySize:        1793,
            SignatureSize:  1280,
            Performance: PerformanceMetrics{
                KeyGenTime: 500 * time.Microsecond,
                SignTime:   800 * time.Microsecond,
                VerifyTime: 100 * time.Microsecond,
            },
            StandardStatus: "FIPS 206 (2024)",
        },
        {
            Name:           "SPHINCS+",
            Category:       "Digital Signature (Hash-based)",
            SecurityLevel:  3,
            KeySize:        64,
            SignatureSize:  49856,
            Performance: PerformanceMetrics{
                KeyGenTime: 50 * time.Microsecond,
                SignTime:   50 * time.Millisecond,
                VerifyTime: 1 * time.Millisecond,
            },
            StandardStatus: "FIPS 205 (2024)",
        },
    }
}

// CompareWithClassical compares PQC with classical algorithms
func CompareWithClassical() {
    fmt.Println("PQC vs Classical Cryptography Comparison")
    fmt.Println("=========================================")

    comparisons := []struct {
        Operation  string
        RSA2048    time.Duration
        ECDSAP256  time.Duration
        Kyber768   time.Duration
        Dilithium3 time.Duration
    }{
        {
            Operation:  "Key Generation",
            RSA2048:    50 * time.Millisecond,
            ECDSAP256:  200 * time.Microsecond,
            Kyber768:   50 * time.Microsecond,
            Dilithium3: 100 * time.Microsecond,
        },
        {
            Operation:  "Sign/Encrypt",
            RSA2048:    5 * time.Millisecond,
            ECDSAP256:  300 * time.Microsecond,
            Kyber768:   70 * time.Microsecond,
            Dilithium3: 200 * time.Microsecond,
        },
        {
            Operation:  "Verify/Decrypt",
            RSA2048:    200 * time.Microsecond,
            ECDSAP256:  400 * time.Microsecond,
            Kyber768:   80 * time.Microsecond,
            Dilithium3: 100 * time.Microsecond,
        },
    }

    for _, comp := range comparisons {
        fmt.Printf("\n%s:\n", comp.Operation)
        fmt.Printf("  RSA-2048:       %v\n", comp.RSA2048)
        fmt.Printf("  ECDSA-P256:     %v\n", comp.ECDSAP256)
        fmt.Printf("  Kyber-768:      %v (%.1fx faster than RSA)\n",
            comp.Kyber768, float64(comp.RSA2048)/float64(comp.Kyber768))
        fmt.Printf("  Dilithium3:     %v (%.1fx faster than RSA)\n",
            comp.Dilithium3, float64(comp.RSA2048)/float64(comp.Dilithium3))
    }
}
```

### Algorithm Selection Criteria

**Decision Matrix:**
```go
// algorithm_selection.go
package pqc

import (
    "fmt"
)

type UseCaseRequirements struct {
    UseCase            string
    MaxKeySize         int
    MaxSignatureSize   int
    MaxLatency         int // milliseconds
    SecurityLevel      int // 1-5 (NIST levels)
    HardwareConstraint bool
    LegacyInterop      bool
}

type AlgorithmRecommendation struct {
    Primary   string
    Secondary string
    Reasoning string
}

func RecommendAlgorithm(req UseCaseRequirements) AlgorithmRecommendation {
    recommendation := AlgorithmRecommendation{}

    switch req.UseCase {
    case "TLS":
        if req.LegacyInterop {
            recommendation.Primary = "Kyber768 + X25519 (Hybrid)"
            recommendation.Secondary = "Dilithium3 + ECDSA (Hybrid)"
            recommendation.Reasoning = "Hybrid mode ensures compatibility with legacy systems while providing quantum resistance"
        } else {
            recommendation.Primary = "Kyber768"
            recommendation.Secondary = "Dilithium3"
            recommendation.Reasoning = "Pure PQC provides maximum quantum resistance with excellent performance"
        }

    case "Code Signing":
        if req.MaxSignatureSize < 5000 {
            recommendation.Primary = "FALCON-512"
            recommendation.Secondary = "Dilithium2"
            recommendation.Reasoning = "FALCON provides smaller signatures suitable for embedded distribution"
        } else {
            recommendation.Primary = "Dilithium3"
            recommendation.Secondary = "SPHINCS+-128f"
            recommendation.Reasoning = "Dilithium offers best balance of security and performance for code signing"
        }

    case "IoT/Embedded":
        if req.HardwareConstraint {
            recommendation.Primary = "SPHINCS+-128s"
            recommendation.Secondary = "FALCON-512"
            recommendation.Reasoning = "Hash-based signatures minimize memory requirements for constrained devices"
        } else {
            recommendation.Primary = "Kyber512"
            recommendation.Secondary = "Dilithium2"
            recommendation.Reasoning = "Lower security levels acceptable for IoT with performance constraints"
        }

    case "PKI/CA":
        recommendation.Primary = "SPHINCS+-256s"
        recommendation.Secondary = "Dilithium5"
        recommendation.Reasoning = "Highest security level required for certificate authorities with stateless signatures"

    case "VPN/IPSec":
        recommendation.Primary = "Kyber1024"
        recommendation.Secondary = "Kyber768 + X25519"
        recommendation.Reasoning = "High security level for long-term VPN connections with hybrid fallback"

    case "Email Encryption":
        recommendation.Primary = "Kyber768"
        recommendation.Secondary = "NTRU"
        recommendation.Reasoning = "Standard security level with good performance for asynchronous communication"

    case "Document Signing":
        if req.MaxLatency < 100 {
            recommendation.Primary = "Dilithium3"
            recommendation.Secondary = "FALCON-1024"
            recommendation.Reasoning = "Fast signature generation and verification for interactive workflows"
        } else {
            recommendation.Primary = "SPHINCS+-256f"
            recommendation.Secondary = "Dilithium5"
            recommendation.Reasoning = "Maximum security for long-term document authenticity"
        }

    default:
        recommendation.Primary = "Kyber768"
        recommendation.Secondary = "Dilithium3"
        recommendation.Reasoning = "General-purpose algorithms suitable for most applications"
    }

    return recommendation
}

// PrintRecommendations generates a comprehensive recommendation report
func PrintRecommendations() {
    useCases := []UseCaseRequirements{
        {UseCase: "TLS", MaxLatency: 50, SecurityLevel: 3, LegacyInterop: true},
        {UseCase: "Code Signing", MaxSignatureSize: 4096, SecurityLevel: 3},
        {UseCase: "IoT/Embedded", MaxKeySize: 2048, SecurityLevel: 1, HardwareConstraint: true},
        {UseCase: "PKI/CA", SecurityLevel: 5},
        {UseCase: "VPN/IPSec", SecurityLevel: 4, LegacyInterop: true},
        {UseCase: "Email Encryption", MaxLatency: 1000, SecurityLevel: 3},
        {UseCase: "Document Signing", MaxLatency: 50, SecurityLevel: 3},
    }

    fmt.Println("PQC Algorithm Recommendations by Use Case")
    fmt.Println("==========================================\n")

    for _, uc := range useCases {
        rec := RecommendAlgorithm(uc)
        fmt.Printf("Use Case: %s\n", uc.UseCase)
        fmt.Printf("  Primary:   %s\n", rec.Primary)
        fmt.Printf("  Secondary: %s\n", rec.Secondary)
        fmt.Printf("  Reasoning: %s\n\n", rec.Reasoning)
    }
}
```

## Hybrid Cryptography Implementation

### Hybrid TLS Configuration

**Hybrid PQC + Classical TLS:**
```go
// hybrid_tls.go
package hybridtls

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "io/ioutil"
    "net/http"

    "github.com/cloudflare/circl/kem"
    "github.com/cloudflare/circl/kem/kyber/kyber768"
)

// HybridTLSConfig configures hybrid PQC + classical TLS
type HybridTLSConfig struct {
    ClassicalCert     tls.Certificate
    PQCPublicKey      []byte
    PQCPrivateKey     []byte
    HybridMode        string // "concatenate", "cascade", "dual-signature"
    FallbackToClassical bool
}

func (h *HybridTLSConfig) NewTLSConfig() (*tls.Config, error) {
    // Configure hybrid key exchange
    config := &tls.Config{
        Certificates: []tls.Certificate{h.ClassicalCert},
        MinVersion:   tls.VersionTLS13,
        CipherSuites: h.getHybridCipherSuites(),
    }

    // Add PQC extension support
    if err := h.configurePQCExtensions(config); err != nil {
        return nil, fmt.Errorf("failed to configure PQC extensions: %w", err)
    }

    return config, nil
}

func (h *HybridTLSConfig) getHybridCipherSuites() []uint16 {
    // Hybrid cipher suites combining PQC with classical algorithms
    return []uint16{
        // TLS_KYBER768_X25519_AES_256_GCM_SHA384
        0x1301, // Placeholder for hybrid suite

        // TLS_AES_256_GCM_SHA384 (classical fallback)
        tls.TLS_AES_256_GCM_SHA384,

        // TLS_CHACHA20_POLY1305_SHA256 (classical fallback)
        tls.TLS_CHACHA20_POLY1305_SHA256,
    }
}

func (h *HybridTLSConfig) configurePQCExtensions(config *tls.Config) error {
    // Custom function to handle PQC key exchange
    config.GetConfigForClient = func(info *tls.ClientHelloInfo) (*tls.Config, error) {
        // Check if client supports PQC
        supportsPQC := h.clientSupportsPQC(info)

        if supportsPQC {
            return h.getPQCConfig(), nil
        } else if h.FallbackToClassical {
            return h.getClassicalConfig(), nil
        } else {
            return nil, fmt.Errorf("client does not support PQC and fallback is disabled")
        }
    }

    return nil
}

func (h *HybridTLSConfig) clientSupportsPQC(info *tls.ClientHelloInfo) bool {
    // Check for PQC extension in client hello
    // Extension ID for hybrid key exchange (placeholder)
    pqcExtensionID := uint16(0xFE00)

    for _, ext := range info.SupportedCurves {
        if uint16(ext) == pqcExtensionID {
            return true
        }
    }

    return false
}

func (h *HybridTLSConfig) getPQCConfig() *tls.Config {
    // Return configuration with PQC enabled
    return &tls.Config{
        MinVersion: tls.VersionTLS13,
        // PQC-specific configuration
    }
}

func (h *HybridTLSConfig) getClassicalConfig() *tls.Config {
    // Return classical TLS configuration
    return &tls.Config{
        MinVersion:   tls.VersionTLS13,
        CipherSuites: []uint16{
            tls.TLS_AES_256_GCM_SHA384,
            tls.TLS_CHACHA20_POLY1305_SHA256,
        },
    }
}

// HybridKeyExchange performs hybrid KEM operation
type HybridKeyExchange struct {
    ClassicalKEM kem.Scheme
    PQCKEM       kem.Scheme
    CombineMode  string
}

func NewHybridKeyExchange() *HybridKeyExchange {
    return &HybridKeyExchange{
        PQCKEM:      kyber768.Scheme(),
        CombineMode: "concatenate",
    }
}

func (h *HybridKeyExchange) GenerateKeyPair() ([]byte, []byte, error) {
    // Generate PQC key pair
    pqcPublicKey, pqcPrivateKey, err := h.PQCKEM.GenerateKeyPair()
    if err != nil {
        return nil, nil, fmt.Errorf("PQC key generation failed: %w", err)
    }

    // For hybrid mode, combine with classical key
    hybridPublic := h.combinePublicKeys(nil, pqcPublicKey)
    hybridPrivate := h.combinePrivateKeys(nil, pqcPrivateKey)

    return hybridPublic, hybridPrivate, nil
}

func (h *HybridKeyExchange) Encapsulate(publicKey []byte) ([]byte, []byte, error) {
    // Extract PQC public key
    pqcPublicKey := h.extractPQCPublicKey(publicKey)

    // Perform PQC encapsulation
    ciphertext, sharedSecret, err := h.PQCKEM.Encapsulate(pqcPublicKey)
    if err != nil {
        return nil, nil, fmt.Errorf("PQC encapsulation failed: %w", err)
    }

    // Combine with classical KEM if in hybrid mode
    hybridCiphertext := h.combineCiphertexts(nil, ciphertext)
    hybridSecret := h.combineSharedSecrets(nil, sharedSecret)

    return hybridCiphertext, hybridSecret, nil
}

func (h *HybridKeyExchange) Decapsulate(privateKey, ciphertext []byte) ([]byte, error) {
    // Extract PQC components
    pqcPrivateKey := h.extractPQCPrivateKey(privateKey)
    pqcCiphertext := h.extractPQCCiphertext(ciphertext)

    // Perform PQC decapsulation
    sharedSecret, err := h.PQCKEM.Decapsulate(pqcPrivateKey, pqcCiphertext)
    if err != nil {
        return nil, fmt.Errorf("PQC decapsulation failed: %w", err)
    }

    // Combine with classical shared secret if in hybrid mode
    hybridSecret := h.combineSharedSecrets(nil, sharedSecret)

    return hybridSecret, nil
}

func (h *HybridKeyExchange) combinePublicKeys(classical, pqc []byte) []byte {
    switch h.CombineMode {
    case "concatenate":
        return append(classical, pqc...)
    case "cascade":
        // Nested encryption: classical(PQC(data))
        return pqc // Placeholder
    default:
        return pqc
    }
}

func (h *HybridKeyExchange) combinePrivateKeys(classical, pqc []byte) []byte {
    return append(classical, pqc...)
}

func (h *HybridKeyExchange) combineCiphertexts(classical, pqc []byte) []byte {
    return append(classical, pqc...)
}

func (h *HybridKeyExchange) combineSharedSecrets(classical, pqc []byte) []byte {
    // Use KDF to combine secrets
    combined := append(classical, pqc...)
    // Apply HKDF or similar KDF
    return combined // Simplified
}

func (h *HybridKeyExchange) extractPQCPublicKey(hybrid []byte) []byte {
    // Extract PQC portion from hybrid key
    return hybrid // Simplified
}

func (h *HybridKeyExchange) extractPQCPrivateKey(hybrid []byte) []byte {
    return hybrid // Simplified
}

func (h *HybridKeyExchange) extractPQCCiphertext(hybrid []byte) []byte {
    return hybrid // Simplified
}

// HybridTLSServer demonstrates hybrid TLS server
func HybridTLSServer() error {
    // Load classical certificate
    cert, err := tls.LoadX509KeyPair("server.crt", "server.key")
    if err != nil {
        return fmt.Errorf("failed to load certificate: %w", err)
    }

    // Generate PQC key pair
    hybridKEX := NewHybridKeyExchange()
    pqcPublic, pqcPrivate, err := hybridKEX.GenerateKeyPair()
    if err != nil {
        return fmt.Errorf("failed to generate PQC keys: %w", err)
    }

    // Create hybrid TLS configuration
    hybridConfig := &HybridTLSConfig{
        ClassicalCert:       cert,
        PQCPublicKey:        pqcPublic,
        PQCPrivateKey:       pqcPrivate,
        HybridMode:          "concatenate",
        FallbackToClassical: true,
    }

    tlsConfig, err := hybridConfig.NewTLSConfig()
    if err != nil {
        return fmt.Errorf("failed to create TLS config: %w", err)
    }

    // Create HTTPS server with hybrid TLS
    server := &http.Server{
        Addr:      ":8443",
        TLSConfig: tlsConfig,
        Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Write([]byte("Hybrid PQC + Classical TLS Server\n"))
        }),
    }

    fmt.Println("Starting hybrid TLS server on :8443")
    return server.ListenAndServeTLS("", "")
}

// HybridTLSClient demonstrates hybrid TLS client
func HybridTLSClient(serverURL string) error {
    // Load CA certificate
    caCert, err := ioutil.ReadFile("ca.crt")
    if err != nil {
        return fmt.Errorf("failed to load CA certificate: %w", err)
    }

    caCertPool := x509.NewCertPool()
    caCertPool.AppendCertsFromPEM(caCert)

    // Configure hybrid TLS client
    tlsConfig := &tls.Config{
        RootCAs:    caCertPool,
        MinVersion: tls.VersionTLS13,
        // PQC-specific client configuration
    }

    client := &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: tlsConfig,
        },
    }

    resp, err := client.Get(serverURL)
    if err != nil {
        return fmt.Errorf("failed to connect: %w", err)
    }
    defer resp.Body.Close()

    body, _ := ioutil.ReadAll(resp.Body)
    fmt.Printf("Response: %s\n", body)

    return nil
}
```

### Hybrid PKI Architecture

**PQC-Enhanced Certificate Authority:**
```yaml
# hybrid-pki-architecture.yaml
apiVersion: pki.quantum.io/v1
kind: HybridCertificateAuthority
metadata:
  name: enterprise-hybrid-ca
  namespace: pki-system
spec:
  architecture:
    mode: "dual-signature"
    description: "Certificates signed with both classical and PQC algorithms"

  classicalCA:
    algorithm: "RSA-4096"
    keyPair:
      privateKeySecret: "ca-rsa-private-key"
      publicKeyCert: "ca-rsa-certificate"
    validity: "10 years"

  postQuantumCA:
    algorithm: "Dilithium5"
    keyPair:
      privateKeySecret: "ca-dilithium-private-key"
      publicKeyCert: "ca-dilithium-certificate"
    validity: "10 years"

  certificateProfile:
    dualSignature:
      enabled: true
      signatureOrder:
        - "classical"
        - "post-quantum"
      verificationPolicy: "require-both" # or "accept-either"

    extensions:
      - oid: "1.3.6.1.4.1.99999.1"
        critical: false
        value: "hybrid-pqc-classical"

  issuancePolicy:
    defaultValidity: "1 year"
    maxValidity: "2 years"

    keyUsage:
      - digitalSignature
      - keyEncipherment
      - dataEncipherment

    extendedKeyUsage:
      - serverAuth
      - clientAuth

    subjectAlternativeNames:
      dnsNames: []
      ipAddresses: []

  revocation:
    crlEnabled: true
    crlDistributionPoints:
      - "http://crl.example.com/hybrid-ca.crl"

    ocspEnabled: true
    ocspResponderURL: "http://ocsp.example.com"

  storage:
    backend: "vault"
    vaultConfig:
      address: "https://vault.example.com:8200"
      path: "pki/hybrid-ca"
      tokenSecret: "vault-token"

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: pqc-algorithm-config
  namespace: pki-system
data:
  algorithms.yaml: |
    keyEncapsulation:
      primary: "Kyber768"
      fallback: "X25519"
      hybridMode: "concatenate"

    digitalSignature:
      primary: "Dilithium3"
      fallback: "ECDSA-P256"
      hybridMode: "dual-signature"

    hashFunction:
      primary: "SHA3-256"
      fallback: "SHA-256"

    symmetricEncryption:
      algorithm: "AES-256-GCM"
      keyDerivation: "HKDF-SHA3-256"
```

## Migration Strategy and Planning

### Cryptographic Inventory

**Asset Discovery and Assessment:**
```go
// crypto_inventory.go
package inventory

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "net"
    "time"
)

// CryptoAsset represents a cryptographic asset in the infrastructure
type CryptoAsset struct {
    ID               string
    Type             string // certificate, key, protocol, service
    Location         string
    Algorithm        string
    KeySize          int
    CreatedAt        time.Time
    ExpiresAt        time.Time
    QuantumVulnerable bool
    MigrationPriority string
    Dependencies     []string
}

// CryptoInventory manages the inventory of cryptographic assets
type CryptoInventory struct {
    Assets          []CryptoAsset
    TotalAssets     int
    VulnerableCount int
    MigrationPlan   *MigrationPlan
}

type MigrationPlan struct {
    Phases         []MigrationPhase
    TotalDuration  time.Duration
    EstimatedCost  float64
    RiskLevel      string
}

type MigrationPhase struct {
    Name          string
    Duration      time.Duration
    Assets        []string
    Dependencies  []string
    Milestone     string
    Status        string
}

// DiscoverCryptoAssets scans infrastructure for cryptographic assets
func (ci *CryptoInventory) DiscoverCryptoAssets() error {
    fmt.Println("Discovering cryptographic assets...")

    // Discover TLS certificates
    if err := ci.discoverTLSCertificates(); err != nil {
        return fmt.Errorf("failed to discover TLS certificates: %w", err)
    }

    // Discover SSH keys
    if err := ci.discoverSSHKeys(); err != nil {
        return fmt.Errorf("failed to discover SSH keys: %w", err)
    }

    // Discover VPN configurations
    if err := ci.discoverVPNConfigs(); err != nil {
        return fmt.Errorf("failed to discover VPN configs: %w", err)
    }

    // Discover code signing certificates
    if err := ci.discoverCodeSigningCerts(); err != nil {
        return fmt.Errorf("failed to discover code signing certs: %w", err)
    }

    // Analyze quantum vulnerability
    ci.analyzeQuantumVulnerability()

    return nil
}

func (ci *CryptoInventory) discoverTLSCertificates() error {
    // Scan common TLS endpoints
    endpoints := []string{
        "api.example.com:443",
        "www.example.com:443",
        "internal.example.com:443",
    }

    for _, endpoint := range endpoints {
        conn, err := tls.Dial("tcp", endpoint, &tls.Config{
            InsecureSkipVerify: true,
        })
        if err != nil {
            fmt.Printf("Failed to connect to %s: %v\n", endpoint, err)
            continue
        }
        defer conn.Close()

        state := conn.ConnectionState()
        for _, cert := range state.PeerCertificates {
            asset := CryptoAsset{
                ID:        fmt.Sprintf("tls-cert-%s", cert.SerialNumber),
                Type:      "TLS Certificate",
                Location:  endpoint,
                Algorithm: cert.PublicKeyAlgorithm.String(),
                CreatedAt: cert.NotBefore,
                ExpiresAt: cert.NotAfter,
            }

            // Determine key size
            switch pub := cert.PublicKey.(type) {
            case *rsa.PublicKey:
                asset.KeySize = pub.N.BitLen()
            case *ecdsa.PublicKey:
                asset.KeySize = pub.Params().BitSize
            }

            ci.Assets = append(ci.Assets, asset)
        }
    }

    return nil
}

func (ci *CryptoInventory) discoverSSHKeys() error {
    // Scan SSH servers
    sshHosts := []string{
        "ssh.example.com:22",
        "bastion.example.com:22",
    }

    for _, host := range sshHosts {
        conn, err := net.DialTimeout("tcp", host, 5*time.Second)
        if err != nil {
            fmt.Printf("Failed to connect to SSH host %s: %v\n", host, err)
            continue
        }
        conn.Close()

        asset := CryptoAsset{
            ID:       fmt.Sprintf("ssh-host-%s", host),
            Type:     "SSH Host Key",
            Location: host,
            // Additional SSH key analysis would go here
        }

        ci.Assets = append(ci.Assets, asset)
    }

    return nil
}

func (ci *CryptoInventory) discoverVPNConfigs() error {
    // Discover VPN configurations
    vpnConfigs := []string{
        "/etc/ipsec.conf",
        "/etc/openvpn/server.conf",
        "/etc/wireguard/wg0.conf",
    }

    for _, configPath := range vpnConfigs {
        asset := CryptoAsset{
            ID:       fmt.Sprintf("vpn-config-%s", configPath),
            Type:     "VPN Configuration",
            Location: configPath,
        }

        ci.Assets = append(ci.Assets, asset)
    }

    return nil
}

func (ci *CryptoInventory) discoverCodeSigningCerts() error {
    // Discover code signing certificates
    asset := CryptoAsset{
        ID:       "code-signing-cert-1",
        Type:     "Code Signing Certificate",
        Location: "/etc/pki/code-signing/",
    }

    ci.Assets = append(ci.Assets, asset)

    return nil
}

func (ci *CryptoInventory) analyzeQuantumVulnerability() {
    for i := range ci.Assets {
        asset := &ci.Assets[i]

        // Determine quantum vulnerability
        switch asset.Algorithm {
        case "RSA", "RSASSA-PKCS1-v1_5", "RSASSA-PSS":
            asset.QuantumVulnerable = true
            if asset.KeySize <= 2048 {
                asset.MigrationPriority = "CRITICAL"
            } else {
                asset.MigrationPriority = "HIGH"
            }

        case "ECDSA", "ECDH":
            asset.QuantumVulnerable = true
            asset.MigrationPriority = "HIGH"

        case "DSA":
            asset.QuantumVulnerable = true
            asset.MigrationPriority = "CRITICAL"

        default:
            asset.QuantumVulnerable = false
            asset.MigrationPriority = "LOW"
        }

        if asset.QuantumVulnerable {
            ci.VulnerableCount++
        }
    }

    ci.TotalAssets = len(ci.Assets)
}

// GenerateMigrationPlan creates a phased migration plan
func (ci *CryptoInventory) GenerateMigrationPlan() *MigrationPlan {
    plan := &MigrationPlan{
        RiskLevel: ci.assessOverallRisk(),
    }

    // Phase 1: Critical Assets
    phase1 := MigrationPhase{
        Name:      "Phase 1: Critical Asset Migration",
        Duration:  6 * 30 * 24 * time.Hour, // 6 months
        Milestone: "Migrate all CRITICAL priority assets",
        Status:    "pending",
    }

    for _, asset := range ci.Assets {
        if asset.MigrationPriority == "CRITICAL" {
            phase1.Assets = append(phase1.Assets, asset.ID)
        }
    }

    // Phase 2: High Priority Assets
    phase2 := MigrationPhase{
        Name:      "Phase 2: High Priority Migration",
        Duration:  12 * 30 * 24 * time.Hour, // 12 months
        Milestone: "Migrate all HIGH priority assets",
        Status:    "pending",
        Dependencies: []string{"Phase 1"},
    }

    for _, asset := range ci.Assets {
        if asset.MigrationPriority == "HIGH" {
            phase2.Assets = append(phase2.Assets, asset.ID)
        }
    }

    // Phase 3: Remaining Assets
    phase3 := MigrationPhase{
        Name:      "Phase 3: Complete Migration",
        Duration:  18 * 30 * 24 * time.Hour, // 18 months
        Milestone: "Migrate all remaining assets",
        Status:    "pending",
        Dependencies: []string{"Phase 2"},
    }

    for _, asset := range ci.Assets {
        if asset.MigrationPriority != "CRITICAL" && asset.MigrationPriority != "HIGH" {
            phase3.Assets = append(phase3.Assets, asset.ID)
        }
    }

    plan.Phases = []MigrationPhase{phase1, phase2, phase3}
    plan.TotalDuration = phase1.Duration + phase2.Duration + phase3.Duration
    plan.EstimatedCost = ci.estimateMigrationCost()

    ci.MigrationPlan = plan
    return plan
}

func (ci *CryptoInventory) assessOverallRisk() string {
    criticalCount := 0
    highCount := 0

    for _, asset := range ci.Assets {
        switch asset.MigrationPriority {
        case "CRITICAL":
            criticalCount++
        case "HIGH":
            highCount++
        }
    }

    if criticalCount > 10 {
        return "CRITICAL"
    } else if criticalCount > 0 || highCount > 20 {
        return "HIGH"
    } else if highCount > 0 {
        return "MEDIUM"
    }

    return "LOW"
}

func (ci *CryptoInventory) estimateMigrationCost() float64 {
    // Estimate based on number of assets and complexity
    baseCostPerAsset := 1000.0 // $1000 per asset

    totalCost := float64(len(ci.Assets)) * baseCostPerAsset

    // Add complexity multipliers
    if ci.MigrationPlan.RiskLevel == "CRITICAL" {
        totalCost *= 2.0
    } else if ci.MigrationPlan.RiskLevel == "HIGH" {
        totalCost *= 1.5
    }

    return totalCost
}

// PrintInventoryReport generates a comprehensive inventory report
func (ci *CryptoInventory) PrintInventoryReport() {
    fmt.Println("\n===== Cryptographic Asset Inventory Report =====")
    fmt.Printf("Total Assets: %d\n", ci.TotalAssets)
    fmt.Printf("Quantum Vulnerable: %d (%.1f%%)\n",
        ci.VulnerableCount,
        float64(ci.VulnerableCount)/float64(ci.TotalAssets)*100)

    fmt.Println("\nAsset Breakdown by Priority:")
    priorities := map[string]int{
        "CRITICAL": 0,
        "HIGH":     0,
        "MEDIUM":   0,
        "LOW":      0,
    }

    for _, asset := range ci.Assets {
        priorities[asset.MigrationPriority]++
    }

    for priority, count := range priorities {
        fmt.Printf("  %s: %d assets\n", priority, count)
    }

    if ci.MigrationPlan != nil {
        fmt.Println("\n===== Migration Plan Summary =====")
        fmt.Printf("Overall Risk Level: %s\n", ci.MigrationPlan.RiskLevel)
        fmt.Printf("Total Duration: %.0f months\n",
            ci.MigrationPlan.TotalDuration.Hours()/24/30)
        fmt.Printf("Estimated Cost: $%.2f\n", ci.MigrationPlan.EstimatedCost)

        fmt.Println("\nMigration Phases:")
        for _, phase := range ci.MigrationPlan.Phases {
            fmt.Printf("\n  %s\n", phase.Name)
            fmt.Printf("    Duration: %.0f months\n", phase.Duration.Hours()/24/30)
            fmt.Printf("    Assets: %d\n", len(phase.Assets))
            fmt.Printf("    Milestone: %s\n", phase.Milestone)
            fmt.Printf("    Status: %s\n", phase.Status)
        }
    }
}
```

### Kubernetes PQC Migration

**PQC-Enabled Kubernetes Configuration:**
```yaml
# kubernetes-pqc-migration.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pqc-migration-config
  namespace: kube-system
data:
  migration-strategy.yaml: |
    strategy:
      name: "Gradual PQC Migration"
      approach: "blue-green"
      rollbackEnabled: true

    phases:
      - name: "Control Plane"
        priority: 1
        components:
          - kube-apiserver
          - etcd
          - kube-controller-manager
          - kube-scheduler
        duration: "3 months"

      - name: "Worker Nodes"
        priority: 2
        components:
          - kubelet
          - kube-proxy
        duration: "6 months"

      - name: "Service Mesh"
        priority: 3
        components:
          - istio-ingressgateway
          - istio-egressgateway
          - envoy-sidecars
        duration: "4 months"

      - name: "Applications"
        priority: 4
        components:
          - application-pods
          - service-endpoints
        duration: "12 months"

---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: pqc-crypto-updater
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: pqc-crypto-updater
  template:
    metadata:
      labels:
        app: pqc-crypto-updater
    spec:
      hostNetwork: true
      hostPID: true
      containers:
      - name: crypto-updater
        image: supporttools/pqc-crypto-updater:1.0
        securityContext:
          privileged: true
        env:
        - name: PQC_ALGORITHM
          value: "kyber768"
        - name: HYBRID_MODE
          value: "true"
        - name: FALLBACK_CLASSICAL
          value: "true"
        volumeMounts:
        - name: crypto-config
          mountPath: /etc/crypto
        - name: host-root
          mountPath: /host
          readOnly: false
        command:
        - /usr/local/bin/update-crypto.sh
        args:
        - --mode=hybrid
        - --algorithm=kyber768
        - --fallback=x25519
        - --update-kubelet
        - --update-containerd
        - --update-certificates
      volumes:
      - name: crypto-config
        configMap:
          name: pqc-migration-config
      - name: host-root
        hostPath:
          path: /

---
apiVersion: v1
kind: Service
metadata:
  name: pqc-api-gateway
  namespace: default
spec:
  type: LoadBalancer
  selector:
    app: pqc-api-gateway
  ports:
  - name: https-pqc
    port: 443
    targetPort: 8443
    protocol: TCP
  sessionAffinity: ClientIP

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pqc-api-gateway
  namespace: default
spec:
  replicas: 3
  selector:
    matchLabels:
      app: pqc-api-gateway
  template:
    metadata:
      labels:
        app: pqc-api-gateway
      annotations:
        pqc.security.io/enabled: "true"
        pqc.security.io/algorithm: "kyber768"
        pqc.security.io/hybrid-mode: "true"
    spec:
      containers:
      - name: gateway
        image: supporttools/pqc-nginx:1.25-pqc
        ports:
        - containerPort: 8443
          name: https-pqc
        env:
        - name: PQC_ENABLED
          value: "true"
        - name: PQC_ALGORITHM
          value: "kyber768+x25519"
        - name: SIGNATURE_ALGORITHM
          value: "dilithium3+ecdsa"
        volumeMounts:
        - name: pqc-certs
          mountPath: /etc/nginx/certs
          readOnly: true
        - name: nginx-config
          mountPath: /etc/nginx/nginx.conf
          subPath: nginx.conf
        resources:
          requests:
            memory: "256Mi"
            cpu: "500m"
          limits:
            memory: "512Mi"
            cpu: "1000m"
      volumes:
      - name: pqc-certs
        secret:
          secretName: pqc-tls-certificate
      - name: nginx-config
        configMap:
          name: pqc-nginx-config

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: pqc-nginx-config
  namespace: default
data:
  nginx.conf: |
    user nginx;
    worker_processes auto;
    error_log /var/log/nginx/error.log warn;
    pid /var/run/nginx.pid;

    # Load PQC module
    load_module modules/ngx_http_pqc_module.so;

    events {
        worker_connections 1024;
        use epoll;
    }

    http {
        include /etc/nginx/mime.types;
        default_type application/octet-stream;

        # PQC configuration
        pqc_enabled on;
        pqc_algorithms kyber768 dilithium3;
        pqc_hybrid_mode on;
        pqc_fallback_classical on;

        # SSL configuration with PQC
        ssl_protocols TLSv1.3;
        ssl_ciphers 'KYBER768+X25519:AES256-GCM-SHA384:CHACHA20-POLY1305-SHA256';
        ssl_prefer_server_ciphers on;

        ssl_certificate /etc/nginx/certs/pqc-server.crt;
        ssl_certificate_key /etc/nginx/certs/pqc-server.key;

        # Classical fallback certificates
        ssl_certificate /etc/nginx/certs/classical-server.crt;
        ssl_certificate_key /etc/nginx/certs/classical-server.key;

        # Performance tuning
        ssl_session_cache shared:SSL:10m;
        ssl_session_timeout 10m;
        ssl_session_tickets off;

        # Security headers
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-PQC-Enabled "true" always;
        add_header X-PQC-Algorithm "kyber768+x25519" always;

        server {
            listen 8443 ssl http2;
            server_name api.example.com;

            location / {
                proxy_pass http://backend-service:8080;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto $scheme;

                # PQC-specific headers
                proxy_set_header X-PQC-Enabled $pqc_enabled;
                proxy_set_header X-PQC-Algorithm $pqc_algorithm;
            }

            location /health {
                access_log off;
                return 200 "healthy\n";
                add_header Content-Type text/plain;
            }
        }
    }
```

## Performance Optimization and Monitoring

### PQC Performance Benchmarking

**Comprehensive Performance Testing:**
```go
// pqc_performance.go
package performance

import (
    "crypto/rand"
    "fmt"
    "time"

    "github.com/cloudflare/circl/kem/kyber/kyber768"
    "github.com/cloudflare/circl/sign/dilithium/mode3"
)

// BenchmarkResult stores performance metrics
type BenchmarkResult struct {
    Algorithm      string
    Operation      string
    Iterations     int
    TotalDuration  time.Duration
    AvgDuration    time.Duration
    OpsPerSecond   float64
    BytesProcessed int64
}

// PQCBenchmark performs comprehensive PQC benchmarking
type PQCBenchmark struct {
    Results []BenchmarkResult
}

func NewPQCBenchmark() *PQCBenchmark {
    return &PQCBenchmark{
        Results: make([]BenchmarkResult, 0),
    }
}

func (b *PQCBenchmark) BenchmarkKyber768() error {
    scheme := kyber768.Scheme()
    iterations := 1000

    // Benchmark key generation
    keyGenStart := time.Now()
    for i := 0; i < iterations; i++ {
        _, _, err := scheme.GenerateKeyPair()
        if err != nil {
            return fmt.Errorf("key generation failed: %w", err)
        }
    }
    keyGenDuration := time.Since(keyGenStart)

    b.Results = append(b.Results, BenchmarkResult{
        Algorithm:     "Kyber768",
        Operation:     "KeyGeneration",
        Iterations:    iterations,
        TotalDuration: keyGenDuration,
        AvgDuration:   keyGenDuration / time.Duration(iterations),
        OpsPerSecond:  float64(iterations) / keyGenDuration.Seconds(),
    })

    // Generate keys for encapsulation benchmarking
    publicKey, _, err := scheme.GenerateKeyPair()
    if err != nil {
        return fmt.Errorf("failed to generate keys for benchmarking: %w", err)
    }

    // Benchmark encapsulation
    encapStart := time.Now()
    var totalCiphertext int64
    for i := 0; i < iterations; i++ {
        ciphertext, _, err := scheme.Encapsulate(publicKey)
        if err != nil {
            return fmt.Errorf("encapsulation failed: %w", err)
        }
        totalCiphertext += int64(len(ciphertext))
    }
    encapDuration := time.Since(encapStart)

    b.Results = append(b.Results, BenchmarkResult{
        Algorithm:      "Kyber768",
        Operation:      "Encapsulation",
        Iterations:     iterations,
        TotalDuration:  encapDuration,
        AvgDuration:    encapDuration / time.Duration(iterations),
        OpsPerSecond:   float64(iterations) / encapDuration.Seconds(),
        BytesProcessed: totalCiphertext,
    })

    // Benchmark decapsulation
    _, privateKey, err := scheme.GenerateKeyPair()
    if err != nil {
        return fmt.Errorf("failed to generate keys for decapsulation: %w", err)
    }

    ciphertext, _, err := scheme.Encapsulate(privateKey.Public())
    if err != nil {
        return fmt.Errorf("failed to create ciphertext: %w", err)
    }

    decapStart := time.Now()
    for i := 0; i < iterations; i++ {
        _, err := scheme.Decapsulate(privateKey, ciphertext)
        if err != nil {
            return fmt.Errorf("decapsulation failed: %w", err)
        }
    }
    decapDuration := time.Since(decapStart)

    b.Results = append(b.Results, BenchmarkResult{
        Algorithm:     "Kyber768",
        Operation:     "Decapsulation",
        Iterations:    iterations,
        TotalDuration: decapDuration,
        AvgDuration:   decapDuration / time.Duration(iterations),
        OpsPerSecond:  float64(iterations) / decapDuration.Seconds(),
    })

    return nil
}

func (b *PQCBenchmark) BenchmarkDilithium3() error {
    scheme := mode3.Scheme()
    iterations := 1000

    // Benchmark key generation
    keyGenStart := time.Now()
    for i := 0; i < iterations; i++ {
        _, _, err := scheme.GenerateKey(rand.Reader)
        if err != nil {
            return fmt.Errorf("key generation failed: %w", err)
        }
    }
    keyGenDuration := time.Since(keyGenStart)

    b.Results = append(b.Results, BenchmarkResult{
        Algorithm:     "Dilithium3",
        Operation:     "KeyGeneration",
        Iterations:    iterations,
        TotalDuration: keyGenDuration,
        AvgDuration:   keyGenDuration / time.Duration(iterations),
        OpsPerSecond:  float64(iterations) / keyGenDuration.Seconds(),
    })

    // Generate keys for signing benchmarking
    publicKey, privateKey, err := scheme.GenerateKey(rand.Reader)
    if err != nil {
        return fmt.Errorf("failed to generate keys: %w", err)
    }

    message := []byte("Benchmark message for PQC performance testing")

    // Benchmark signing
    signStart := time.Now()
    var totalSigSize int64
    for i := 0; i < iterations; i++ {
        signature := scheme.Sign(privateKey, message, nil)
        totalSigSize += int64(len(signature))
    }
    signDuration := time.Since(signStart)

    b.Results = append(b.Results, BenchmarkResult{
        Algorithm:      "Dilithium3",
        Operation:      "Signing",
        Iterations:     iterations,
        TotalDuration:  signDuration,
        AvgDuration:    signDuration / time.Duration(iterations),
        OpsPerSecond:   float64(iterations) / signDuration.Seconds(),
        BytesProcessed: totalSigSize,
    })

    // Benchmark verification
    signature := scheme.Sign(privateKey, message, nil)

    verifyStart := time.Now()
    for i := 0; i < iterations; i++ {
        if !scheme.Verify(publicKey, message, signature, nil) {
            return fmt.Errorf("signature verification failed")
        }
    }
    verifyDuration := time.Since(verifyStart)

    b.Results = append(b.Results, BenchmarkResult{
        Algorithm:     "Dilithium3",
        Operation:     "Verification",
        Iterations:    iterations,
        TotalDuration: verifyDuration,
        AvgDuration:   verifyDuration / time.Duration(iterations),
        OpsPerSecond:  float64(iterations) / verifyDuration.Seconds(),
    })

    return nil
}

func (b *PQCBenchmark) PrintResults() {
    fmt.Println("\n===== PQC Performance Benchmark Results =====\n")

    for _, result := range b.Results {
        fmt.Printf("%s - %s:\n", result.Algorithm, result.Operation)
        fmt.Printf("  Iterations:    %d\n", result.Iterations)
        fmt.Printf("  Total Time:    %v\n", result.TotalDuration)
        fmt.Printf("  Average Time:  %v\n", result.AvgDuration)
        fmt.Printf("  Ops/Second:    %.2f\n", result.OpsPerSecond)

        if result.BytesProcessed > 0 {
            throughput := float64(result.BytesProcessed) / result.TotalDuration.Seconds() / (1024 * 1024)
            fmt.Printf("  Throughput:    %.2f MB/s\n", throughput)
        }

        fmt.Println()
    }
}

func (b *PQCBenchmark) CompareWithClassical() {
    fmt.Println("===== PQC vs Classical Comparison =====\n")

    classicalPerformance := map[string]map[string]float64{
        "RSA-2048": {
            "KeyGeneration": 20.0,      // ops/sec
            "Signing":       1000.0,    // ops/sec
            "Verification":  50000.0,   // ops/sec
        },
        "ECDSA-P256": {
            "KeyGeneration": 5000.0,    // ops/sec
            "Signing":       3500.0,    // ops/sec
            "Verification":  10000.0,   // ops/sec
        },
    }

    for _, result := range b.Results {
        if result.Algorithm == "Dilithium3" {
            if classical, ok := classicalPerformance["RSA-2048"][result.Operation]; ok {
                ratio := result.OpsPerSecond / classical
                fmt.Printf("%s %s:\n", result.Algorithm, result.Operation)
                fmt.Printf("  PQC:       %.2f ops/sec\n", result.OpsPerSecond)
                fmt.Printf("  RSA-2048:  %.2f ops/sec\n", classical)
                fmt.Printf("  Ratio:     %.2fx %s\n",
                    ratio,
                    map[bool]string{true: "faster", false: "slower"}[ratio > 1.0])
                fmt.Println()
            }
        }
    }
}
```

### PQC Monitoring and Observability

**Prometheus Metrics for PQC:**
```go
// pqc_metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // PQC handshake metrics
    pqcHandshakeDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "pqc_tls_handshake_duration_seconds",
            Help:    "Duration of PQC TLS handshakes",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        },
        []string{"algorithm", "hybrid_mode", "result"},
    )

    pqcHandshakeTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "pqc_tls_handshake_total",
            Help: "Total number of PQC TLS handshakes",
        },
        []string{"algorithm", "hybrid_mode", "result"},
    )

    // Key exchange metrics
    pqcKeyExchangeDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "pqc_key_exchange_duration_seconds",
            Help:    "Duration of PQC key exchange operations",
            Buckets: prometheus.ExponentialBuckets(0.0001, 2, 15),
        },
        []string{"algorithm", "operation"},
    )

    // Signature metrics
    pqcSignatureDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "pqc_signature_duration_seconds",
            Help:    "Duration of PQC signature operations",
            Buckets: prometheus.ExponentialBuckets(0.0001, 2, 15),
        },
        []string{"algorithm", "operation"},
    )

    // Migration metrics
    pqcMigrationProgress = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "pqc_migration_progress_percent",
            Help: "Progress of PQC migration by component",
        },
        []string{"component", "phase"},
    )

    pqcCertificateExpiry = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "pqc_certificate_expiry_seconds",
            Help: "Time until PQC certificate expiry",
        },
        []string{"certificate", "algorithm"},
    )

    // Fallback metrics
    pqcFallbackTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "pqc_classical_fallback_total",
            Help: "Total number of fallbacks to classical cryptography",
        },
        []string{"reason", "component"},
    )

    // Performance metrics
    pqcOperationSize = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "pqc_operation_size_bytes",
            Help:    "Size of PQC cryptographic operations",
            Buckets: prometheus.ExponentialBuckets(256, 2, 12),
        },
        []string{"algorithm", "operation"},
    )
)

// RecordHandshake records TLS handshake metrics
func RecordHandshake(algorithm string, hybridMode bool, duration float64, success bool) {
    hybrid := "false"
    if hybridMode {
        hybrid = "true"
    }

    result := "success"
    if !success {
        result = "failure"
    }

    pqcHandshakeDuration.WithLabelValues(algorithm, hybrid, result).Observe(duration)
    pqcHandshakeTotal.WithLabelValues(algorithm, hybrid, result).Inc()
}

// RecordKeyExchange records key exchange operation metrics
func RecordKeyExchange(algorithm, operation string, duration float64) {
    pqcKeyExchangeDuration.WithLabelValues(algorithm, operation).Observe(duration)
}

// RecordSignature records signature operation metrics
func RecordSignature(algorithm, operation string, duration float64) {
    pqcSignatureDuration.WithLabelValues(algorithm, operation).Observe(duration)
}

// UpdateMigrationProgress updates migration progress gauge
func UpdateMigrationProgress(component, phase string, progress float64) {
    pqcMigrationProgress.WithLabelValues(component, phase).Set(progress)
}

// UpdateCertificateExpiry updates certificate expiry gauge
func UpdateCertificateExpiry(certificate, algorithm string, secondsUntilExpiry float64) {
    pqcCertificateExpiry.WithLabelValues(certificate, algorithm).Set(secondsUntilExpiry)
}

// RecordFallback records classical cryptography fallback
func RecordFallback(reason, component string) {
    pqcFallbackTotal.WithLabelValues(reason, component).Inc()
}

// RecordOperationSize records the size of cryptographic operations
func RecordOperationSize(algorithm, operation string, sizeBytes int) {
    pqcOperationSize.WithLabelValues(algorithm, operation).Observe(float64(sizeBytes))
}
```

**Grafana Dashboard Configuration:**
```yaml
# pqc-grafana-dashboard.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pqc-grafana-dashboard
  namespace: monitoring
data:
  pqc-dashboard.json: |
    {
      "dashboard": {
        "title": "Post-Quantum Cryptography Monitoring",
        "panels": [
          {
            "title": "PQC TLS Handshake Rate",
            "targets": [
              {
                "expr": "rate(pqc_tls_handshake_total[5m])",
                "legendFormat": "{{algorithm}} ({{hybrid_mode}})"
              }
            ],
            "type": "graph"
          },
          {
            "title": "PQC Handshake Duration (p95)",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, rate(pqc_tls_handshake_duration_seconds_bucket[5m]))",
                "legendFormat": "{{algorithm}} ({{hybrid_mode}})"
              }
            ],
            "type": "graph"
          },
          {
            "title": "Migration Progress",
            "targets": [
              {
                "expr": "pqc_migration_progress_percent",
                "legendFormat": "{{component}} - {{phase}}"
              }
            ],
            "type": "graph"
          },
          {
            "title": "Certificate Expiry",
            "targets": [
              {
                "expr": "pqc_certificate_expiry_seconds / 86400",
                "legendFormat": "{{certificate}} ({{algorithm}})"
              }
            ],
            "type": "graph"
          },
          {
            "title": "Classical Fallback Rate",
            "targets": [
              {
                "expr": "rate(pqc_classical_fallback_total[5m])",
                "legendFormat": "{{reason}} - {{component}}"
              }
            ],
            "type": "graph"
          },
          {
            "title": "Key Exchange Performance",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, rate(pqc_key_exchange_duration_seconds_bucket[5m]))",
                "legendFormat": "{{algorithm}} - {{operation}}"
              }
            ],
            "type": "graph"
          },
          {
            "title": "Signature Performance",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, rate(pqc_signature_duration_seconds_bucket[5m]))",
                "legendFormat": "{{algorithm}} - {{operation}}"
              }
            ],
            "type": "graph"
          },
          {
            "title": "Operation Size Distribution",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, rate(pqc_operation_size_bytes_bucket[5m]))",
                "legendFormat": "{{algorithm}} - {{operation}}"
              }
            ],
            "type": "graph"
          }
        ]
      }
    }
```

## Conclusion

Preparing for quantum-safe cryptography is a critical long-term security initiative that requires:

1. **Comprehensive Assessment**: Inventory all cryptographic assets and assess quantum vulnerability
2. **Standards Adoption**: Implement NIST-standardized PQC algorithms (Kyber, Dilithium, FALCON, SPHINCS+)
3. **Hybrid Approach**: Deploy hybrid PQC + classical cryptography for transition period
4. **Phased Migration**: Execute gradual migration plan with proper testing and validation
5. **Performance Monitoring**: Continuously monitor PQC performance and optimization opportunities
6. **Ongoing Adaptation**: Stay current with evolving PQC standards and quantum computing threats

The quantum threat is real, and organizations must begin preparing now to protect their long-term data security. By implementing the strategies outlined in this guide, enterprises can establish quantum-resistant cryptographic infrastructure that provides security against both current and future threats.

For more information on quantum-safe cryptography and enterprise security, visit [support.tools](https://support.tools).