---
title: "Advanced PKI Certificate Management for Enterprise Infrastructure: Complete Implementation Guide"
date: 2026-04-13T00:00:00-05:00
draft: false
tags: ["PKI", "Certificate Management", "Security", "Cryptography", "X.509", "Certificate Authority", "mTLS", "TLS", "OpenSSL", "ACME", "Kubernetes", "HashiCorp Vault"]
categories:
- Security
- PKI
- Certificate Management
- Cryptography
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing advanced PKI certificate management for enterprise infrastructure, including automated certificate lifecycle management, multi-tier CA hierarchies, and production-ready certificate operations."
more_link: "yes"
url: "/advanced-pki-certificate-management-enterprise-infrastructure-guide/"
---

Public Key Infrastructure (PKI) forms the backbone of modern enterprise security, enabling secure communications, authentication, and data integrity across distributed systems. This comprehensive guide covers advanced PKI certificate management strategies, from establishing certificate authorities to implementing automated certificate lifecycle management in large-scale enterprise environments.

<!--more-->

# [Advanced PKI Certificate Management for Enterprise Infrastructure](#advanced-pki-certificate-management)

## Section 1: PKI Architecture and Design Principles

Enterprise PKI implementation requires careful architectural planning to ensure scalability, security, and operational efficiency across diverse infrastructure components.

### Multi-Tier Certificate Authority Hierarchy

```bash
#!/bin/bash
# create-ca-hierarchy.sh

# Create directory structure for CA hierarchy
mkdir -p /opt/ca/{root,intermediate,issuing}/{private,certs,crl,newcerts,csr}
chmod 700 /opt/ca/*/private

# Initialize CA database files
for ca_type in root intermediate issuing; do
    touch /opt/ca/${ca_type}/index.txt
    echo 1000 > /opt/ca/${ca_type}/serial
    echo 1000 > /opt/ca/${ca_type}/crlnumber
done

# Root CA configuration
cat > /opt/ca/root/openssl.cnf << 'EOF'
[ ca ]
default_ca = CA_default

[ CA_default ]
dir               = /opt/ca/root
certs             = $dir/certs
crl_dir           = $dir/crl
new_certs_dir     = $dir/newcerts
database          = $dir/index.txt
serial            = $dir/serial
RANDFILE          = $dir/private/.rand
private_key       = $dir/private/ca.key.pem
certificate       = $dir/certs/ca.cert.pem
crlnumber         = $dir/crlnumber
crl               = $dir/crl/ca.crl.pem
crl_extensions    = crl_ext
default_crl_days  = 30
default_md        = sha256
name_opt          = ca_default
cert_opt          = ca_default
default_days      = 3650
preserve          = no
policy            = policy_strict

[ policy_strict ]
countryName             = match
stateOrProvinceName     = match
organizationName        = match
organizationalUnitName  = optional
commonName              = supplied
emailAddress            = optional

[ req ]
default_bits        = 4096
distinguished_name  = req_distinguished_name
string_mask         = utf8only
default_md          = sha256
x509_extensions     = v3_ca

[ req_distinguished_name ]
countryName                     = Country Name (2 letter code)
stateOrProvinceName             = State or Province Name
localityName                    = Locality Name
0.organizationName              = Organization Name
organizationalUnitName          = Organizational Unit Name
commonName                      = Common Name
emailAddress                    = Email Address

[ v3_ca ]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, cRLSign, keyCertSign

[ v3_intermediate_ca ]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, digitalSignature, cRLSign, keyCertSign
EOF

# Create Root CA private key
openssl genrsa -aes256 -out /opt/ca/root/private/ca.key.pem 4096
chmod 400 /opt/ca/root/private/ca.key.pem

# Create Root CA certificate
openssl req -config /opt/ca/root/openssl.cnf \
    -key /opt/ca/root/private/ca.key.pem \
    -new -x509 -days 7300 -sha256 -extensions v3_ca \
    -out /opt/ca/root/certs/ca.cert.pem
chmod 444 /opt/ca/root/certs/ca.cert.pem
```

### Certificate Authority Management System

```go
// ca-manager.go
package main

import (
    "crypto/rand"
    "crypto/rsa"
    "crypto/x509"
    "crypto/x509/pkix"
    "encoding/pem"
    "fmt"
    "io/ioutil"
    "math/big"
    "time"
)

type CertificateAuthority struct {
    Name        string
    PrivateKey  *rsa.PrivateKey
    Certificate *x509.Certificate
    CRLNumber   *big.Int
    Serial      *big.Int
}

type CertificateRequest struct {
    CommonName         string
    Organization       []string
    OrganizationalUnit []string
    Country            []string
    Province           []string
    Locality           []string
    DNSNames           []string
    IPAddresses        []net.IP
    EmailAddresses     []string
    ValidityPeriod     time.Duration
    KeyUsage           x509.KeyUsage
    ExtKeyUsage        []x509.ExtKeyUsage
}

func NewCertificateAuthority(name string, keySize int) (*CertificateAuthority, error) {
    privateKey, err := rsa.GenerateKey(rand.Reader, keySize)
    if err != nil {
        return nil, fmt.Errorf("failed to generate private key: %v", err)
    }

    template := x509.Certificate{
        SerialNumber: big.NewInt(1),
        Subject: pkix.Name{
            CommonName:   name,
            Organization: []string{"Enterprise PKI"},
        },
        NotBefore:             time.Now(),
        NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
        KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
        ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
        BasicConstraintsValid: true,
        IsCA:                  true,
        MaxPathLen:            2,
    }

    certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &privateKey.PublicKey, privateKey)
    if err != nil {
        return nil, fmt.Errorf("failed to create certificate: %v", err)
    }

    cert, err := x509.ParseCertificate(certDER)
    if err != nil {
        return nil, fmt.Errorf("failed to parse certificate: %v", err)
    }

    return &CertificateAuthority{
        Name:        name,
        PrivateKey:  privateKey,
        Certificate: cert,
        CRLNumber:   big.NewInt(1),
        Serial:      big.NewInt(1000),
    }, nil
}

func (ca *CertificateAuthority) IssueCertificate(req *CertificateRequest) (*x509.Certificate, *rsa.PrivateKey, error) {
    // Generate private key for the certificate
    privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to generate private key: %v", err)
    }

    // Increment serial number
    ca.Serial.Add(ca.Serial, big.NewInt(1))

    template := x509.Certificate{
        SerialNumber: new(big.Int).Set(ca.Serial),
        Subject: pkix.Name{
            CommonName:         req.CommonName,
            Organization:       req.Organization,
            OrganizationalUnit: req.OrganizationalUnit,
            Country:            req.Country,
            Province:           req.Province,
            Locality:           req.Locality,
        },
        NotBefore:    time.Now(),
        NotAfter:     time.Now().Add(req.ValidityPeriod),
        KeyUsage:     req.KeyUsage,
        ExtKeyUsage:  req.ExtKeyUsage,
        DNSNames:     req.DNSNames,
        IPAddresses:  req.IPAddresses,
        EmailAddresses: req.EmailAddresses,
    }

    certDER, err := x509.CreateCertificate(rand.Reader, &template, ca.Certificate, &privateKey.PublicKey, ca.PrivateKey)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to create certificate: %v", err)
    }

    cert, err := x509.ParseCertificate(certDER)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to parse certificate: %v", err)
    }

    return cert, privateKey, nil
}

func (ca *CertificateAuthority) GenerateCRL(revokedCerts []pkix.RevokedCertificate) ([]byte, error) {
    template := x509.RevocationList{
        Number:              ca.CRLNumber,
        ThisUpdate:          time.Now(),
        NextUpdate:          time.Now().Add(24 * time.Hour),
        RevokedCertificates: revokedCerts,
    }

    // Increment CRL number
    ca.CRLNumber.Add(ca.CRLNumber, big.NewInt(1))

    crlDER, err := x509.CreateRevocationList(rand.Reader, &template, ca.Certificate, ca.PrivateKey)
    if err != nil {
        return nil, fmt.Errorf("failed to create CRL: %v", err)
    }

    return crlDER, nil
}

func (ca *CertificateAuthority) SaveToFiles(basePath string) error {
    // Save private key
    keyPEM := pem.EncodeToMemory(&pem.Block{
        Type:  "RSA PRIVATE KEY",
        Bytes: x509.MarshalPKCS1PrivateKey(ca.PrivateKey),
    })
    if err := ioutil.WriteFile(fmt.Sprintf("%s/%s.key", basePath, ca.Name), keyPEM, 0600); err != nil {
        return err
    }

    // Save certificate
    certPEM := pem.EncodeToMemory(&pem.Block{
        Type:  "CERTIFICATE",
        Bytes: ca.Certificate.Raw,
    })
    if err := ioutil.WriteFile(fmt.Sprintf("%s/%s.crt", basePath, ca.Name), certPEM, 0644); err != nil {
        return err
    }

    return nil
}

func (ca *CertificateAuthority) ValidateCertificate(cert *x509.Certificate) error {
    // Verify certificate signature
    if err := cert.CheckSignatureFrom(ca.Certificate); err != nil {
        return fmt.Errorf("certificate signature validation failed: %v", err)
    }

    // Check certificate validity period
    now := time.Now()
    if now.Before(cert.NotBefore) || now.After(cert.NotAfter) {
        return fmt.Errorf("certificate is not valid at current time")
    }

    return nil
}
```

## Section 2: Automated Certificate Lifecycle Management

Implementing automated certificate lifecycle management reduces operational overhead and minimizes security risks associated with certificate expiration.

### ACME Protocol Implementation

```go
// acme-client.go
package main

import (
    "context"
    "crypto/rsa"
    "crypto/x509"
    "fmt"
    "log"
    "time"

    "golang.org/x/crypto/acme"
    "golang.org/x/crypto/acme/autocert"
)

type ACMEClient struct {
    client     *acme.Client
    privateKey *rsa.PrivateKey
    account    *acme.Account
    directoryURL string
}

func NewACMEClient(directoryURL string, privateKey *rsa.PrivateKey) (*ACMEClient, error) {
    client := &acme.Client{
        Key:          privateKey,
        DirectoryURL: directoryURL,
    }

    return &ACMEClient{
        client:       client,
        privateKey:   privateKey,
        directoryURL: directoryURL,
    }, nil
}

func (ac *ACMEClient) RegisterAccount(ctx context.Context, email string) error {
    account := &acme.Account{
        Contact: []string{"mailto:" + email},
    }

    createdAccount, err := ac.client.Register(ctx, account, acme.AcceptTOS)
    if err != nil {
        return fmt.Errorf("failed to register ACME account: %v", err)
    }

    ac.account = createdAccount
    return nil
}

func (ac *ACMEClient) ObtainCertificate(ctx context.Context, domains []string) (*x509.Certificate, *rsa.PrivateKey, error) {
    // Create new order
    order, err := ac.client.AuthorizeOrder(ctx, acme.DomainIDs(domains...))
    if err != nil {
        return nil, nil, fmt.Errorf("failed to create order: %v", err)
    }

    // Complete challenges for each authorization
    for _, authzURL := range order.AuthzURLs {
        authz, err := ac.client.GetAuthorization(ctx, authzURL)
        if err != nil {
            return nil, nil, fmt.Errorf("failed to get authorization: %v", err)
        }

        if authz.Status == acme.StatusValid {
            continue
        }

        // Find HTTP-01 challenge
        var httpChallenge *acme.Challenge
        for _, challenge := range authz.Challenges {
            if challenge.Type == "http-01" {
                httpChallenge = challenge
                break
            }
        }

        if httpChallenge == nil {
            return nil, nil, fmt.Errorf("no HTTP-01 challenge found")
        }

        // Set up HTTP challenge response
        if err := ac.setupHTTPChallenge(ctx, httpChallenge); err != nil {
            return nil, nil, fmt.Errorf("failed to setup HTTP challenge: %v", err)
        }

        // Accept challenge
        if _, err := ac.client.Accept(ctx, httpChallenge); err != nil {
            return nil, nil, fmt.Errorf("failed to accept challenge: %v", err)
        }

        // Wait for challenge completion
        if _, err := ac.client.WaitAuthorization(ctx, authzURL); err != nil {
            return nil, nil, fmt.Errorf("challenge failed: %v", err)
        }
    }

    // Generate certificate private key
    certKey, err := rsa.GenerateKey(rand.Reader, 2048)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to generate certificate key: %v", err)
    }

    // Create certificate request
    csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
        Subject: pkix.Name{
            CommonName: domains[0],
        },
        DNSNames: domains,
    }, certKey)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to create CSR: %v", err)
    }

    // Finalize order
    finalOrder, err := ac.client.FinalizeOrder(ctx, order.FinalizeURL, csr)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to finalize order: %v", err)
    }

    // Download certificate
    certChain, err := ac.client.FetchCert(ctx, finalOrder.CertURL, false)
    if err != nil {
        return nil, nil, fmt.Errorf("failed to fetch certificate: %v", err)
    }

    cert, err := x509.ParseCertificate(certChain[0])
    if err != nil {
        return nil, nil, fmt.Errorf("failed to parse certificate: %v", err)
    }

    return cert, certKey, nil
}

func (ac *ACMEClient) setupHTTPChallenge(ctx context.Context, challenge *acme.Challenge) error {
    token := challenge.Token
    keyAuth, err := ac.client.HTTP01ChallengeResponse(token)
    if err != nil {
        return err
    }

    // In a real implementation, you would set up an HTTP server
    // to serve the challenge response at /.well-known/acme-challenge/<token>
    log.Printf("Set up HTTP challenge response: %s -> %s", token, keyAuth)
    
    return nil
}
```

### Certificate Renewal Automation

```go
// certificate-renewal.go
package main

import (
    "context"
    "crypto/x509"
    "encoding/pem"
    "fmt"
    "io/ioutil"
    "log"
    "sync"
    "time"

    "k8s.io/client-go/kubernetes"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type CertificateRenewalManager struct {
    kubeClient       kubernetes.Interface
    acmeClient       *ACMEClient
    renewalThreshold time.Duration
    checkInterval    time.Duration
    certificates     map[string]*CertificateInfo
    mutex            sync.RWMutex
}

type CertificateInfo struct {
    Name         string
    Namespace    string
    SecretName   string
    Domains      []string
    Certificate  *x509.Certificate
    ExpiryTime   time.Time
    LastRenewal  time.Time
}

func NewCertificateRenewalManager(kubeClient kubernetes.Interface, acmeClient *ACMEClient) *CertificateRenewalManager {
    return &CertificateRenewalManager{
        kubeClient:       kubeClient,
        acmeClient:       acmeClient,
        renewalThreshold: 30 * 24 * time.Hour, // 30 days
        checkInterval:    1 * time.Hour,
        certificates:     make(map[string]*CertificateInfo),
    }
}

func (crm *CertificateRenewalManager) Start(ctx context.Context) error {
    ticker := time.NewTicker(crm.checkInterval)
    defer ticker.Stop()

    // Initial discovery
    if err := crm.discoverCertificates(ctx); err != nil {
        return fmt.Errorf("initial certificate discovery failed: %v", err)
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := crm.checkAndRenewCertificates(ctx); err != nil {
                log.Printf("Certificate renewal check failed: %v", err)
            }
        }
    }
}

func (crm *CertificateRenewalManager) discoverCertificates(ctx context.Context) error {
    namespaces, err := crm.kubeClient.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
    if err != nil {
        return err
    }

    for _, ns := range namespaces.Items {
        secrets, err := crm.kubeClient.CoreV1().Secrets(ns.Name).List(ctx, metav1.ListOptions{
            LabelSelector: "type=tls",
        })
        if err != nil {
            log.Printf("Failed to list secrets in namespace %s: %v", ns.Name, err)
            continue
        }

        for _, secret := range secrets.Items {
            certData, exists := secret.Data["tls.crt"]
            if !exists {
                continue
            }

            cert, err := parseCertificate(certData)
            if err != nil {
                log.Printf("Failed to parse certificate in secret %s/%s: %v", secret.Namespace, secret.Name, err)
                continue
            }

            certInfo := &CertificateInfo{
                Name:        fmt.Sprintf("%s-%s", secret.Namespace, secret.Name),
                Namespace:   secret.Namespace,
                SecretName:  secret.Name,
                Domains:     append([]string{cert.Subject.CommonName}, cert.DNSNames...),
                Certificate: cert,
                ExpiryTime:  cert.NotAfter,
            }

            crm.mutex.Lock()
            crm.certificates[certInfo.Name] = certInfo
            crm.mutex.Unlock()

            log.Printf("Discovered certificate: %s (expires: %s)", certInfo.Name, cert.NotAfter.Format(time.RFC3339))
        }
    }

    return nil
}

func (crm *CertificateRenewalManager) checkAndRenewCertificates(ctx context.Context) error {
    crm.mutex.RLock()
    certs := make([]*CertificateInfo, 0, len(crm.certificates))
    for _, cert := range crm.certificates {
        certs = append(certs, cert)
    }
    crm.mutex.RUnlock()

    now := time.Now()
    
    for _, certInfo := range certs {
        timeUntilExpiry := certInfo.ExpiryTime.Sub(now)
        
        if timeUntilExpiry <= crm.renewalThreshold {
            log.Printf("Certificate %s expires in %v, initiating renewal", certInfo.Name, timeUntilExpiry)
            
            if err := crm.renewCertificate(ctx, certInfo); err != nil {
                log.Printf("Failed to renew certificate %s: %v", certInfo.Name, err)
                continue
            }
            
            log.Printf("Successfully renewed certificate %s", certInfo.Name)
        }
    }

    return nil
}

func (crm *CertificateRenewalManager) renewCertificate(ctx context.Context, certInfo *CertificateInfo) error {
    // Obtain new certificate using ACME
    newCert, newKey, err := crm.acmeClient.ObtainCertificate(ctx, certInfo.Domains)
    if err != nil {
        return fmt.Errorf("failed to obtain new certificate: %v", err)
    }

    // Update Kubernetes secret
    if err := crm.updateSecret(ctx, certInfo, newCert, newKey); err != nil {
        return fmt.Errorf("failed to update secret: %v", err)
    }

    // Update certificate info
    crm.mutex.Lock()
    certInfo.Certificate = newCert
    certInfo.ExpiryTime = newCert.NotAfter
    certInfo.LastRenewal = time.Now()
    crm.mutex.Unlock()

    return nil
}

func (crm *CertificateRenewalManager) updateSecret(ctx context.Context, certInfo *CertificateInfo, cert *x509.Certificate, key *rsa.PrivateKey) error {
    secret, err := crm.kubeClient.CoreV1().Secrets(certInfo.Namespace).Get(ctx, certInfo.SecretName, metav1.GetOptions{})
    if err != nil {
        return err
    }

    // Encode certificate
    certPEM := pem.EncodeToMemory(&pem.Block{
        Type:  "CERTIFICATE",
        Bytes: cert.Raw,
    })

    // Encode private key
    keyPEM := pem.EncodeToMemory(&pem.Block{
        Type:  "RSA PRIVATE KEY",
        Bytes: x509.MarshalPKCS1PrivateKey(key),
    })

    secret.Data["tls.crt"] = certPEM
    secret.Data["tls.key"] = keyPEM

    _, err = crm.kubeClient.CoreV1().Secrets(certInfo.Namespace).Update(ctx, secret, metav1.UpdateOptions{})
    return err
}

func parseCertificate(certData []byte) (*x509.Certificate, error) {
    block, _ := pem.Decode(certData)
    if block == nil {
        return nil, fmt.Errorf("failed to parse certificate PEM")
    }

    return x509.ParseCertificate(block.Bytes)
}
```

## Section 3: HashiCorp Vault PKI Integration

HashiCorp Vault provides enterprise-grade PKI capabilities with dynamic certificate generation and comprehensive secret management.

### Vault PKI Engine Configuration

```bash
#!/bin/bash
# configure-vault-pki.sh

# Enable PKI secrets engine
vault secrets enable pki

# Configure max lease TTL
vault secrets tune -max-lease-ttl=87600h pki

# Generate root CA
vault write -field=certificate pki/root/generate/internal \
    common_name="Enterprise Root CA" \
    ttl=87600h > /opt/vault/ca.crt

# Configure CA and CRL URLs
vault write pki/config/urls \
    issuing_certificates="$VAULT_ADDR/v1/pki/ca" \
    crl_distribution_points="$VAULT_ADDR/v1/pki/crl"

# Enable intermediate PKI
vault secrets enable -path=pki_int pki

# Configure intermediate PKI max lease TTL
vault secrets tune -max-lease-ttl=43800h pki_int

# Generate intermediate CSR
vault write -format=json pki_int/intermediate/generate/internal \
    common_name="Enterprise Intermediate CA" \
    | jq -r '.data.csr' > /tmp/pki_intermediate.csr

# Sign intermediate certificate
vault write -format=json pki/root/sign-intermediate \
    csr=@/tmp/pki_intermediate.csr \
    format=pem_bundle ttl="43800h" \
    | jq -r '.data.certificate' > /tmp/intermediate.cert.pem

# Set intermediate certificate
vault write pki_int/intermediate/set-signed \
    certificate=@/tmp/intermediate.cert.pem

# Create role for server certificates
vault write pki_int/roles/server-cert \
    allowed_domains="example.com,internal.corp" \
    allow_subdomains=true \
    max_ttl="720h" \
    require_cn=false \
    allow_ip_sans=true \
    key_type="rsa" \
    key_bits=2048

# Create role for client certificates
vault write pki_int/roles/client-cert \
    allowed_domains="example.com,internal.corp" \
    allow_subdomains=true \
    max_ttl="168h" \
    client_flag=true \
    require_cn=false \
    key_type="rsa" \
    key_bits=2048
```

### Vault PKI Go Client

```go
// vault-pki-client.go
package main

import (
    "context"
    "crypto/x509"
    "encoding/pem"
    "fmt"
    "time"

    vault "github.com/hashicorp/vault/api"
)

type VaultPKIClient struct {
    client    *vault.Client
    mountPath string
}

type CertificateResponse struct {
    Certificate     *x509.Certificate
    PrivateKey      string
    CertificateChain []*x509.Certificate
    SerialNumber    string
    ExpirationTime  time.Time
}

func NewVaultPKIClient(vaultAddr, token, mountPath string) (*VaultPKIClient, error) {
    config := vault.DefaultConfig()
    config.Address = vaultAddr

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create Vault client: %v", err)
    }

    client.SetToken(token)

    return &VaultPKIClient{
        client:    client,
        mountPath: mountPath,
    }, nil
}

func (vpc *VaultPKIClient) IssueCertificate(role, commonName string, altNames []string, ipSans []string, ttl string) (*CertificateResponse, error) {
    data := map[string]interface{}{
        "common_name": commonName,
        "ttl":         ttl,
    }

    if len(altNames) > 0 {
        data["alt_names"] = strings.Join(altNames, ",")
    }

    if len(ipSans) > 0 {
        data["ip_sans"] = strings.Join(ipSans, ",")
    }

    path := fmt.Sprintf("%s/issue/%s", vpc.mountPath, role)
    secret, err := vpc.client.Logical().Write(path, data)
    if err != nil {
        return nil, fmt.Errorf("failed to issue certificate: %v", err)
    }

    if secret == nil || secret.Data == nil {
        return nil, fmt.Errorf("empty response from Vault")
    }

    // Parse certificate
    certPEM := secret.Data["certificate"].(string)
    certBlock, _ := pem.Decode([]byte(certPEM))
    if certBlock == nil {
        return nil, fmt.Errorf("failed to parse certificate PEM")
    }

    cert, err := x509.ParseCertificate(certBlock.Bytes)
    if err != nil {
        return nil, fmt.Errorf("failed to parse certificate: %v", err)
    }

    // Parse certificate chain
    var certChain []*x509.Certificate
    if caChain, exists := secret.Data["ca_chain"].([]interface{}); exists {
        for _, caCertPEM := range caChain {
            caCertBlock, _ := pem.Decode([]byte(caCertPEM.(string)))
            if caCertBlock != nil {
                caCert, err := x509.ParseCertificate(caCertBlock.Bytes)
                if err == nil {
                    certChain = append(certChain, caCert)
                }
            }
        }
    }

    return &CertificateResponse{
        Certificate:     cert,
        PrivateKey:      secret.Data["private_key"].(string),
        CertificateChain: certChain,
        SerialNumber:    secret.Data["serial_number"].(string),
        ExpirationTime:  cert.NotAfter,
    }, nil
}

func (vpc *VaultPKIClient) RevokeCertificate(serialNumber string) error {
    data := map[string]interface{}{
        "serial_number": serialNumber,
    }

    path := fmt.Sprintf("%s/revoke", vpc.mountPath)
    _, err := vpc.client.Logical().Write(path, data)
    if err != nil {
        return fmt.Errorf("failed to revoke certificate: %v", err)
    }

    return nil
}

func (vpc *VaultPKIClient) GetCRL() ([]byte, error) {
    path := fmt.Sprintf("%s/crl/pem", vpc.mountPath)
    req := vpc.client.NewRequest("GET", "/v1/"+path)
    
    resp, err := vpc.client.RawRequest(req)
    if err != nil {
        return nil, fmt.Errorf("failed to get CRL: %v", err)
    }
    defer resp.Body.Close()

    crlData, err := ioutil.ReadAll(resp.Body)
    if err != nil {
        return nil, fmt.Errorf("failed to read CRL response: %v", err)
    }

    return crlData, nil
}

func (vpc *VaultPKIClient) ListCertificates() ([]string, error) {
    path := fmt.Sprintf("%s/certs", vpc.mountPath)
    secret, err := vpc.client.Logical().List(path)
    if err != nil {
        return nil, fmt.Errorf("failed to list certificates: %v", err)
    }

    if secret == nil || secret.Data == nil {
        return []string{}, nil
    }

    keys, ok := secret.Data["keys"].([]interface{})
    if !ok {
        return []string{}, nil
    }

    result := make([]string, len(keys))
    for i, key := range keys {
        result[i] = key.(string)
    }

    return result, nil
}

func (vpc *VaultPKIClient) CreateRole(name string, config map[string]interface{}) error {
    path := fmt.Sprintf("%s/roles/%s", vpc.mountPath, name)
    _, err := vpc.client.Logical().Write(path, config)
    if err != nil {
        return fmt.Errorf("failed to create role: %v", err)
    }

    return nil
}
```

## Section 4: Certificate Monitoring and Alerting

Proactive certificate monitoring prevents service disruptions and ensures compliance with security policies.

### Certificate Expiration Monitor

```go
// certificate-monitor.go
package main

import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "log"
    "net"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

type CertificateMonitor struct {
    targets           []MonitorTarget
    checkInterval     time.Duration
    alertThresholds   []time.Duration
    metrics          *CertificateMetrics
    alertManager     AlertManager
}

type MonitorTarget struct {
    Name     string
    Address  string
    Port     int
    Protocol string
    Timeout  time.Duration
}

type CertificateMetrics struct {
    expiryTime    *prometheus.GaugeVec
    daysUntilExpiry *prometheus.GaugeVec
    validStatus   *prometheus.GaugeVec
    checkErrors   *prometheus.CounterVec
}

type AlertManager interface {
    SendAlert(alert CertificateAlert) error
}

type CertificateAlert struct {
    Target        MonitorTarget
    AlertType     string
    Message       string
    Severity      string
    Certificate   *x509.Certificate
    ExpiryTime    time.Time
    DaysRemaining int
}

func NewCertificateMonitor(targets []MonitorTarget, alertManager AlertManager) *CertificateMonitor {
    metrics := &CertificateMetrics{
        expiryTime: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "certificate_expiry_timestamp",
                Help: "Certificate expiry time as Unix timestamp",
            },
            []string{"target", "common_name", "issuer"},
        ),
        daysUntilExpiry: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "certificate_days_until_expiry",
                Help: "Days until certificate expires",
            },
            []string{"target", "common_name", "issuer"},
        ),
        validStatus: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "certificate_valid_status",
                Help: "Certificate validity status (1=valid, 0=invalid)",
            },
            []string{"target", "common_name", "issuer"},
        ),
        checkErrors: prometheus.NewCounterVec(
            prometheus.CounterOpts{
                Name: "certificate_check_errors_total",
                Help: "Total number of certificate check errors",
            },
            []string{"target", "error_type"},
        ),
    }

    prometheus.MustRegister(
        metrics.expiryTime,
        metrics.daysUntilExpiry,
        metrics.validStatus,
        metrics.checkErrors,
    )

    return &CertificateMonitor{
        targets:         targets,
        checkInterval:   time.Hour,
        alertThresholds: []time.Duration{30 * 24 * time.Hour, 7 * 24 * time.Hour, 24 * time.Hour},
        metrics:         metrics,
        alertManager:    alertManager,
    }
}

func (cm *CertificateMonitor) Start(ctx context.Context) error {
    ticker := time.NewTicker(cm.checkInterval)
    defer ticker.Stop()

    // Initial check
    cm.checkAllCertificates(ctx)

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            cm.checkAllCertificates(ctx)
        }
    }
}

func (cm *CertificateMonitor) checkAllCertificates(ctx context.Context) {
    var wg sync.WaitGroup

    for _, target := range cm.targets {
        wg.Add(1)
        go func(t MonitorTarget) {
            defer wg.Done()
            cm.checkCertificate(ctx, t)
        }(target)
    }

    wg.Wait()
}

func (cm *CertificateMonitor) checkCertificate(ctx context.Context, target MonitorTarget) {
    cert, err := cm.fetchCertificate(ctx, target)
    if err != nil {
        log.Printf("Failed to fetch certificate for %s: %v", target.Name, err)
        cm.metrics.checkErrors.WithLabelValues(target.Name, "fetch_error").Inc()
        return
    }

    // Update metrics
    now := time.Now()
    daysUntilExpiry := cert.NotAfter.Sub(now).Hours() / 24
    
    labels := prometheus.Labels{
        "target":      target.Name,
        "common_name": cert.Subject.CommonName,
        "issuer":      cert.Issuer.CommonName,
    }

    cm.metrics.expiryTime.With(labels).Set(float64(cert.NotAfter.Unix()))
    cm.metrics.daysUntilExpiry.With(labels).Set(daysUntilExpiry)

    // Check certificate validity
    isValid := 1.0
    if now.Before(cert.NotBefore) || now.After(cert.NotAfter) {
        isValid = 0.0
    }
    cm.metrics.validStatus.With(labels).Set(isValid)

    // Check for alerts
    cm.checkAlerts(target, cert)
}

func (cm *CertificateMonitor) fetchCertificate(ctx context.Context, target MonitorTarget) (*x509.Certificate, error) {
    dialer := &net.Dialer{
        Timeout: target.Timeout,
    }

    conn, err := tls.DialWithDialer(dialer, target.Protocol, 
        fmt.Sprintf("%s:%d", target.Address, target.Port), 
        &tls.Config{InsecureSkipVerify: true})
    if err != nil {
        return nil, fmt.Errorf("failed to connect: %v", err)
    }
    defer conn.Close()

    certs := conn.ConnectionState().PeerCertificates
    if len(certs) == 0 {
        return nil, fmt.Errorf("no certificates found")
    }

    return certs[0], nil
}

func (cm *CertificateMonitor) checkAlerts(target MonitorTarget, cert *x509.Certificate) {
    now := time.Now()
    timeUntilExpiry := cert.NotAfter.Sub(now)
    daysRemaining := int(timeUntilExpiry.Hours() / 24)

    for _, threshold := range cm.alertThresholds {
        if timeUntilExpiry <= threshold && timeUntilExpiry > 0 {
            alert := CertificateAlert{
                Target:        target,
                AlertType:     "expiry_warning",
                Message:       fmt.Sprintf("Certificate for %s expires in %d days", target.Name, daysRemaining),
                Severity:      cm.getSeverity(timeUntilExpiry),
                Certificate:   cert,
                ExpiryTime:    cert.NotAfter,
                DaysRemaining: daysRemaining,
            }

            if err := cm.alertManager.SendAlert(alert); err != nil {
                log.Printf("Failed to send alert for %s: %v", target.Name, err)
            }
            break
        }
    }

    // Check if certificate has already expired
    if now.After(cert.NotAfter) {
        alert := CertificateAlert{
            Target:        target,
            AlertType:     "expired",
            Message:       fmt.Sprintf("Certificate for %s has expired", target.Name),
            Severity:      "critical",
            Certificate:   cert,
            ExpiryTime:    cert.NotAfter,
            DaysRemaining: daysRemaining,
        }

        if err := cm.alertManager.SendAlert(alert); err != nil {
            log.Printf("Failed to send alert for %s: %v", target.Name, err)
        }
    }
}

func (cm *CertificateMonitor) getSeverity(timeUntilExpiry time.Duration) string {
    if timeUntilExpiry <= 24*time.Hour {
        return "critical"
    } else if timeUntilExpiry <= 7*24*time.Hour {
        return "high"
    } else if timeUntilExpiry <= 30*24*time.Hour {
        return "medium"
    }
    return "low"
}
```

## Section 5: Kubernetes Certificate Management

Kubernetes environments require specialized certificate management approaches to handle service-to-service communication and cluster security.

### Cert-Manager Configuration

```yaml
# cert-manager-setup.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: cert-manager
---
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: cert-manager
  namespace: kube-system
spec:
  chart: cert-manager
  repo: https://charts.jetstack.io
  targetNamespace: cert-manager
  version: v1.13.0
  set:
    installCRDs: "true"
    prometheus.enabled: "true"
    webhook.timeoutSeconds: "30"
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-issuer
spec:
  vault:
    server: https://vault.internal.corp:8200
    path: pki_int/sign/server-cert
    auth:
      kubernetes:
        mountPath: /v1/auth/kubernetes
        role: cert-manager
        secretRef:
          name: cert-manager-vault-token
          key: token
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: acme-issuer
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: certificates@example.com
    privateKeySecretRef:
      name: acme-issuer-key
    solvers:
    - http01:
        ingress:
          class: nginx
    - dns01:
        cloudflare:
          email: admin@example.com
          apiTokenSecretRef:
            name: cloudflare-token
            key: api-token
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: wildcard-cert
  namespace: default
spec:
  secretName: wildcard-tls
  issuerRef:
    name: acme-issuer
    kind: ClusterIssuer
  commonName: "*.example.com"
  dnsNames:
  - "*.example.com"
  - "example.com"
```

### Custom Certificate Controller

```go
// k8s-certificate-controller.go
package main

import (
    "context"
    "fmt"
    "time"

    certmanagerv1 "github.com/cert-manager/cert-manager/pkg/apis/certmanager/v1"
    certmanagerclient "github.com/cert-manager/cert-manager/pkg/client/clientset/versioned"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/fields"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/cache"
    "k8s.io/client-go/util/workqueue"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

type CertificateController struct {
    kubeClient        kubernetes.Interface
    certManagerClient certmanagerclient.Interface
    queue             workqueue.RateLimitingInterface
    informer          cache.SharedIndexInformer
    vaultPKIClient    *VaultPKIClient
}

func NewCertificateController(kubeClient kubernetes.Interface, certManagerClient certmanagerclient.Interface, vaultPKIClient *VaultPKIClient) *CertificateController {
    queue := workqueue.NewRateLimitingQueue(workqueue.DefaultControllerRateLimiter())
    
    listWatcher := cache.NewListWatchFromClient(
        certManagerClient.CertmanagerV1().RESTClient(),
        "certificates",
        metav1.NamespaceAll,
        fields.Everything(),
    )
    
    informer := cache.NewSharedIndexInformer(
        listWatcher,
        &certmanagerv1.Certificate{},
        time.Hour,
        cache.Indexers{},
    )

    controller := &CertificateController{
        kubeClient:        kubeClient,
        certManagerClient: certManagerClient,
        queue:             queue,
        informer:          informer,
        vaultPKIClient:    vaultPKIClient,
    }

    informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
        AddFunc:    controller.handleCertificateAdd,
        UpdateFunc: controller.handleCertificateUpdate,
        DeleteFunc: controller.handleCertificateDelete,
    })

    return controller
}

func (cc *CertificateController) handleCertificateAdd(obj interface{}) {
    cert := obj.(*certmanagerv1.Certificate)
    cc.queue.Add(fmt.Sprintf("add/%s/%s", cert.Namespace, cert.Name))
}

func (cc *CertificateController) handleCertificateUpdate(oldObj, newObj interface{}) {
    cert := newObj.(*certmanagerv1.Certificate)
    cc.queue.Add(fmt.Sprintf("update/%s/%s", cert.Namespace, cert.Name))
}

func (cc *CertificateController) handleCertificateDelete(obj interface{}) {
    cert := obj.(*certmanagerv1.Certificate)
    cc.queue.Add(fmt.Sprintf("delete/%s/%s", cert.Namespace, cert.Name))
}

func (cc *CertificateController) processItem() bool {
    key, quit := cc.queue.Get()
    if quit {
        return false
    }
    defer cc.queue.Done(key)

    if err := cc.handleCertificateEvent(key.(string)); err != nil {
        cc.queue.AddRateLimited(key)
        return true
    }

    cc.queue.Forget(key)
    return true
}

func (cc *CertificateController) handleCertificateEvent(key string) error {
    parts := strings.Split(key, "/")
    if len(parts) != 3 {
        return fmt.Errorf("invalid key format: %s", key)
    }

    action, namespace, name := parts[0], parts[1], parts[2]

    switch action {
    case "add", "update":
        return cc.processCertificate(namespace, name)
    case "delete":
        return cc.handleCertificateDeletion(namespace, name)
    default:
        return fmt.Errorf("unknown action: %s", action)
    }
}

func (cc *CertificateController) processCertificate(namespace, name string) error {
    cert, err := cc.certManagerClient.CertmanagerV1().Certificates(namespace).Get(
        context.TODO(), name, metav1.GetOptions{})
    if err != nil {
        return err
    }

    // Check if certificate needs custom processing
    if cert.Annotations["pki.enterprise.com/custom-processing"] != "true" {
        return nil
    }

    // Get the associated secret
    secret, err := cc.kubeClient.CoreV1().Secrets(namespace).Get(
        context.TODO(), cert.Spec.SecretName, metav1.GetOptions{})
    if err != nil {
        return err
    }

    // Parse existing certificate
    certData := secret.Data["tls.crt"]
    existingCert, err := parseCertificate(certData)
    if err != nil {
        return err
    }

    // Check if renewal is needed
    renewalThreshold := 30 * 24 * time.Hour
    if time.Until(existingCert.NotAfter) > renewalThreshold {
        return nil // Certificate is still valid
    }

    // Issue new certificate using Vault
    domains := append([]string{cert.Spec.CommonName}, cert.Spec.DNSNames...)
    
    vaultResp, err := cc.vaultPKIClient.IssueCertificate(
        "server-cert",
        cert.Spec.CommonName,
        cert.Spec.DNSNames,
        nil, // IP SANs
        "720h", // 30 days
    )
    if err != nil {
        return fmt.Errorf("failed to issue certificate from Vault: %v", err)
    }

    // Update secret with new certificate
    secret.Data["tls.crt"] = []byte(vaultResp.PrivateKey)
    secret.Data["tls.key"] = []byte(vaultResp.PrivateKey)

    _, err = cc.kubeClient.CoreV1().Secrets(namespace).Update(
        context.TODO(), secret, metav1.UpdateOptions{})
    if err != nil {
        return fmt.Errorf("failed to update secret: %v", err)
    }

    // Update certificate status
    cert.Status.NotAfter = &metav1.Time{Time: vaultResp.ExpirationTime}
    cert.Status.RenewalTime = &metav1.Time{Time: time.Now()}

    _, err = cc.certManagerClient.CertmanagerV1().Certificates(namespace).UpdateStatus(
        context.TODO(), cert, metav1.UpdateOptions{})
    if err != nil {
        return fmt.Errorf("failed to update certificate status: %v", err)
    }

    return nil
}

func (cc *CertificateController) handleCertificateDeletion(namespace, name string) error {
    // Clean up any external resources if needed
    // For example, revoke certificate in Vault
    return nil
}

func (cc *CertificateController) Run(ctx context.Context) error {
    go cc.informer.Run(ctx.Done())

    if !cache.WaitForCacheSync(ctx.Done(), cc.informer.HasSynced) {
        return fmt.Errorf("failed to wait for cache sync")
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            if !cc.processItem() {
                return nil
            }
        }
    }
}
```

This comprehensive PKI certificate management guide provides enterprise-grade solutions for certificate lifecycle management, automated renewal, and integration with modern infrastructure platforms. Organizations can adapt these implementations to their specific security requirements while maintaining operational efficiency and compliance standards.
