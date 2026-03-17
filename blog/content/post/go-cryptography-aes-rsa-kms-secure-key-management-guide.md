---
title: "Go Cryptography Patterns: AES Encryption, RSA Signing, and Secure Key Management"
date: 2030-11-15T00:00:00-05:00
draft: false
tags: ["Go", "Cryptography", "AES", "RSA", "ECDSA", "KMS", "Security", "Key Management"]
categories:
- Go
- Security
- Cryptography
author: "Matthew Mattox - mmattox@support.tools"
description: "Production cryptography in Go: AES-GCM symmetric encryption, RSA and ECDSA signing workflows, X.509 certificate generation, key derivation with HKDF, envelope encryption patterns, and integrating with cloud KMS (AWS KMS, GCP KMS) for key management."
more_link: "yes"
url: "/go-cryptography-aes-rsa-kms-secure-key-management-guide/"
---

Implementing cryptography correctly in Go requires more than calling the right functions — it requires understanding the security properties of each primitive, the failure modes when they are misused, and the operational patterns for key lifecycle management. This guide covers the cryptographic building blocks used in production Go services: authenticated symmetric encryption with AES-GCM, digital signatures with RSA-PSS and ECDSA, X.509 certificate operations, key derivation, and envelope encryption backed by cloud KMS.

<!--more-->

## Cryptographic Principles for Production Systems

Before writing any cryptographic code, three principles must be understood:

1. **Never roll your own crypto**: Use Go's `crypto/` standard library and well-audited packages. Never implement AES, RSA, or hash functions manually.
2. **Authenticated encryption is mandatory**: Unauthenticated encryption (AES-CBC without MAC, raw RSA PKCS#1 v1.5 encryption) is insecure against adaptive chosen-ciphertext attacks. Always use AES-GCM or ChaCha20-Poly1305 for symmetric encryption, and OAEP for RSA encryption.
3. **Nonces must be unique**: AES-GCM catastrophically fails if a (key, nonce) pair is ever reused. Use random 12-byte nonces generated with `crypto/rand`.

## AES-GCM Symmetric Encryption

AES-256-GCM provides authenticated encryption with associated data (AEAD). The 256-bit key means a 32-byte key; the nonce is 12 bytes; the authentication tag is 16 bytes.

```go
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
)

// EncryptAESGCM encrypts plaintext with AES-256-GCM.
// The returned ciphertext includes the nonce prepended to the ciphertext+tag.
// Format: [12-byte nonce][ciphertext+16-byte tag]
//
// aad (additional authenticated data) is authenticated but not encrypted —
// use it to bind ciphertext to a context (e.g., record ID, user ID) to prevent
// ciphertext splicing attacks. Pass nil if not needed.
func EncryptAESGCM(key, plaintext, aad []byte) ([]byte, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("EncryptAESGCM: key must be 32 bytes, got %d", len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("EncryptAESGCM: create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("EncryptAESGCM: create GCM: %w", err)
	}

	// Generate a cryptographically random nonce.
	nonce := make([]byte, gcm.NonceSize()) // 12 bytes for standard GCM
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("EncryptAESGCM: generate nonce: %w", err)
	}

	// Seal appends the encrypted ciphertext and authentication tag to nonce.
	ciphertext := gcm.Seal(nonce, nonce, plaintext, aad)
	return ciphertext, nil
}

// DecryptAESGCM decrypts and authenticates ciphertext produced by EncryptAESGCM.
func DecryptAESGCM(key, ciphertext, aad []byte) ([]byte, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("DecryptAESGCM: key must be 32 bytes, got %d", len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("DecryptAESGCM: create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("DecryptAESGCM: create GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize+gcm.Overhead() {
		return nil, errors.New("DecryptAESGCM: ciphertext too short")
	}

	nonce, ciphertextBody := ciphertext[:nonceSize], ciphertext[nonceSize:]

	plaintext, err := gcm.Open(nil, nonce, ciphertextBody, aad)
	if err != nil {
		// Do not reveal whether the failure was tag mismatch or decryption error.
		return nil, errors.New("DecryptAESGCM: authentication failed")
	}

	return plaintext, nil
}

// GenerateAES256Key generates a cryptographically random 32-byte AES key.
func GenerateAES256Key() ([]byte, error) {
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("GenerateAES256Key: %w", err)
	}
	return key, nil
}
```

### Usage Example

```go
func ExampleEncryptDecrypt() {
	key, _ := crypto.GenerateAES256Key()

	// Bind ciphertext to the record it belongs to
	aad := []byte("record-id:user:42")

	plaintext := []byte("sensitive user data: SSN 123-45-6789")

	ciphertext, err := crypto.EncryptAESGCM(key, plaintext, aad)
	if err != nil {
		log.Fatalf("encrypt: %v", err)
	}

	// Decryption fails if aad doesn't match — prevents ciphertext from being
	// moved to a different record context.
	recovered, err := crypto.DecryptAESGCM(key, ciphertext, aad)
	if err != nil {
		log.Fatalf("decrypt: %v", err)
	}

	// recovered == plaintext
	_ = recovered
}
```

## Key Derivation with HKDF

Deriving multiple keys from a single master key or a password-based key is done with HKDF (HMAC-based Key Derivation Function, RFC 5869). HKDF separates extraction (converting entropy into a uniform key) from expansion (generating multiple key outputs).

```go
package crypto

import (
	"crypto/sha256"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

// DeriveKey derives a key of the specified length from a master key and context.
//
// masterKey: the input key material (must have sufficient entropy).
// salt:      random salt, should be 32 bytes. Use a fixed salt only if no
//            random salt is available (e.g., password-derived keys use bcrypt
//            salt instead).
// info:      context binding string (e.g., "aes-encryption-key", "hmac-signing-key").
//            Different info strings produce independent, unrelated keys from the
//            same masterKey+salt combination.
// keyLen:    desired output key length in bytes.
func DeriveKey(masterKey, salt []byte, info string, keyLen int) ([]byte, error) {
	if len(masterKey) < 16 {
		return nil, fmt.Errorf("DeriveKey: masterKey must be at least 16 bytes")
	}

	h := hkdf.New(sha256.New, masterKey, salt, []byte(info))
	derived := make([]byte, keyLen)

	if _, err := io.ReadFull(h, derived); err != nil {
		return nil, fmt.Errorf("DeriveKey: expand: %w", err)
	}

	return derived, nil
}

// DeriveEncryptionAndMACKeys derives an independent encryption key and HMAC key
// from a single master key — a common pattern for encrypt-then-MAC constructions.
func DeriveEncryptionAndMACKeys(masterKey, salt []byte) (encKey, macKey []byte, err error) {
	encKey, err = DeriveKey(masterKey, salt, "aes-256-gcm-encryption", 32)
	if err != nil {
		return nil, nil, err
	}
	macKey, err = DeriveKey(masterKey, salt, "hmac-sha256-authentication", 32)
	if err != nil {
		return nil, nil, err
	}
	return encKey, macKey, nil
}
```

## RSA-PSS Digital Signatures

RSA-PSS (Probabilistic Signature Scheme) is the recommended RSA signature scheme. RSA PKCS#1 v1.5 signatures are deterministic and vulnerable to certain fault attacks; PSS is preferred for new code.

```go
package crypto

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"
)

// SignRSAPSS signs data with an RSA private key using PSS padding and SHA-256.
// Returns the DER-encoded signature.
func SignRSAPSS(privateKey *rsa.PrivateKey, data []byte) ([]byte, error) {
	digest := sha256.Sum256(data)

	signature, err := rsa.SignPSS(rand.Reader, privateKey, crypto.SHA256, digest[:],
		&rsa.PSSOptions{
			SaltLength: rsa.PSSSaltLengthAuto,
			Hash:       crypto.SHA256,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("SignRSAPSS: %w", err)
	}

	return signature, nil
}

// VerifyRSAPSS verifies a PSS signature against a public key.
func VerifyRSAPSS(publicKey *rsa.PublicKey, data, signature []byte) error {
	digest := sha256.Sum256(data)

	return rsa.VerifyPSS(publicKey, crypto.SHA256, digest[:], signature,
		&rsa.PSSOptions{
			SaltLength: rsa.PSSSaltLengthAuto,
			Hash:       crypto.SHA256,
		},
	)
}

// GenerateRSA4096Key generates a 4096-bit RSA key pair.
// For high-frequency signing, prefer ECDSA P-256 which is ~10x faster.
func GenerateRSA4096Key() (*rsa.PrivateKey, error) {
	return rsa.GenerateKey(rand.Reader, 4096)
}

// MarshalPrivateKeyToPEM encodes an RSA private key to PKCS#8 PEM format.
// PKCS#8 is preferred over PKCS#1 because it is algorithm-agnostic.
func MarshalPrivateKeyToPEM(key *rsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("MarshalPrivateKeyToPEM: %w", err)
	}

	return pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: der,
	}), nil
}

// ParsePrivateKeyFromPEM parses a PKCS#8 PEM-encoded RSA private key.
func ParsePrivateKeyFromPEM(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("ParsePrivateKeyFromPEM: no PEM block found")
	}

	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("ParsePrivateKeyFromPEM: parse: %w", err)
	}

	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("ParsePrivateKeyFromPEM: not an RSA key")
	}

	return rsaKey, nil
}
```

## ECDSA P-256 Signatures

ECDSA P-256 provides equivalent security to RSA-3072 with keys that are 1/50th the size and signatures that are ~10x faster to generate. It is the preferred algorithm for JWT signing, TLS client certificates, and high-frequency signing use cases.

```go
package crypto

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
	"fmt"
	"math/big"
)

// ecdsaSignature is the DER-encoded ECDSA signature structure (r, s integers).
type ecdsaSignature struct {
	R, S *big.Int
}

// SignECDSA signs data with an ECDSA P-256 private key.
func SignECDSA(privateKey *ecdsa.PrivateKey, data []byte) ([]byte, error) {
	digest := sha256.Sum256(data)

	r, s, err := ecdsa.Sign(rand.Reader, privateKey, digest[:])
	if err != nil {
		return nil, fmt.Errorf("SignECDSA: %w", err)
	}

	// Encode as DER for interoperability.
	sig, err := asn1.Marshal(ecdsaSignature{R: r, S: s})
	if err != nil {
		return nil, fmt.Errorf("SignECDSA: marshal: %w", err)
	}

	return sig, nil
}

// VerifyECDSA verifies a DER-encoded ECDSA signature.
func VerifyECDSA(publicKey *ecdsa.PublicKey, data, signature []byte) error {
	var sig ecdsaSignature
	if _, err := asn1.Unmarshal(signature, &sig); err != nil {
		return fmt.Errorf("VerifyECDSA: unmarshal signature: %w", err)
	}

	digest := sha256.Sum256(data)

	if !ecdsa.Verify(publicKey, digest[:], sig.R, sig.S) {
		return fmt.Errorf("VerifyECDSA: signature verification failed")
	}

	return nil
}

// GenerateECDSAP256Key generates a P-256 ECDSA key pair.
func GenerateECDSAP256Key() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

// MarshalECPrivateKeyToPEM encodes an ECDSA private key to PKCS#8 PEM.
func MarshalECPrivateKeyToPEM(key *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("MarshalECPrivateKeyToPEM: %w", err)
	}

	return pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: der,
	}), nil
}

// PublicKeyToPEM encodes a public key (RSA or ECDSA) to PKIX PEM format.
func PublicKeyToPEM(pubKey interface{}) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(pubKey)
	if err != nil {
		return nil, fmt.Errorf("PublicKeyToPEM: %w", err)
	}

	return pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: der,
	}), nil
}
```

## Envelope Encryption Pattern

Envelope encryption is the standard pattern for key management at scale: a data encryption key (DEK) is generated per record, used to encrypt the data, and the DEK itself is encrypted by a key encryption key (KEK) stored in a KMS. Only the encrypted DEK is stored alongside the ciphertext.

```go
package crypto

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

// EncryptedEnvelope represents an envelope-encrypted payload.
type EncryptedEnvelope struct {
	// EncryptedDEK is the base64-encoded DEK encrypted by the KMS CMK.
	EncryptedDEK string `json:"encrypted_dek"`
	// Ciphertext is the base64-encoded AES-GCM ciphertext of the payload.
	Ciphertext string `json:"ciphertext"`
	// KeyID identifies which KMS key was used to encrypt the DEK.
	KeyID string `json:"key_id"`
}

// KEKProvider abstracts KMS operations. Implementations exist for AWS KMS,
// GCP KMS, HashiCorp Vault, and local development testing.
type KEKProvider interface {
	// EncryptDEK encrypts a data encryption key using the CMK identified by keyID.
	EncryptDEK(ctx context.Context, keyID string, dek []byte) (encryptedDEK []byte, err error)
	// DecryptDEK decrypts an encrypted DEK using the CMK identified by keyID.
	DecryptDEK(ctx context.Context, keyID string, encryptedDEK []byte) (dek []byte, err error)
}

// SealEnvelope encrypts plaintext using a freshly generated DEK, then wraps the
// DEK with the KMS CMK identified by keyID.
func SealEnvelope(ctx context.Context, provider KEKProvider, keyID string, plaintext, aad []byte) (*EncryptedEnvelope, error) {
	// Step 1: Generate a new random DEK for this payload.
	dek, err := GenerateAES256Key()
	if err != nil {
		return nil, fmt.Errorf("SealEnvelope: generate DEK: %w", err)
	}
	defer func() {
		// Zero the DEK in memory after use.
		for i := range dek {
			dek[i] = 0
		}
	}()

	// Step 2: Encrypt the payload with the DEK.
	ciphertext, err := EncryptAESGCM(dek, plaintext, aad)
	if err != nil {
		return nil, fmt.Errorf("SealEnvelope: encrypt payload: %w", err)
	}

	// Step 3: Encrypt the DEK with the KMS CMK.
	encryptedDEK, err := provider.EncryptDEK(ctx, keyID, dek)
	if err != nil {
		return nil, fmt.Errorf("SealEnvelope: encrypt DEK via KMS: %w", err)
	}

	return &EncryptedEnvelope{
		EncryptedDEK: base64.StdEncoding.EncodeToString(encryptedDEK),
		Ciphertext:   base64.StdEncoding.EncodeToString(ciphertext),
		KeyID:        keyID,
	}, nil
}

// OpenEnvelope decrypts an envelope by first recovering the DEK from KMS,
// then using the DEK to decrypt the payload.
func OpenEnvelope(ctx context.Context, provider KEKProvider, env *EncryptedEnvelope, aad []byte) ([]byte, error) {
	encryptedDEK, err := base64.StdEncoding.DecodeString(env.EncryptedDEK)
	if err != nil {
		return nil, fmt.Errorf("OpenEnvelope: decode EncryptedDEK: %w", err)
	}

	ciphertext, err := base64.StdEncoding.DecodeString(env.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("OpenEnvelope: decode Ciphertext: %w", err)
	}

	// Step 1: Recover the DEK from KMS.
	dek, err := provider.DecryptDEK(ctx, env.KeyID, encryptedDEK)
	if err != nil {
		return nil, fmt.Errorf("OpenEnvelope: decrypt DEK: %w", err)
	}
	defer func() {
		for i := range dek {
			dek[i] = 0
		}
	}()

	// Step 2: Decrypt the payload with the recovered DEK.
	plaintext, err := DecryptAESGCM(dek, ciphertext, aad)
	if err != nil {
		return nil, fmt.Errorf("OpenEnvelope: decrypt payload: %w", err)
	}

	return plaintext, nil
}
```

## AWS KMS Integration

```go
package kms

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
)

// AWSKMSProvider implements KEKProvider using AWS KMS.
type AWSKMSProvider struct {
	client *kms.Client
}

// NewAWSKMSProvider creates an AWSKMSProvider using the default credential chain.
func NewAWSKMSProvider(ctx context.Context, region string) (*AWSKMSProvider, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("NewAWSKMSProvider: load config: %w", err)
	}

	return &AWSKMSProvider{client: kms.NewFromConfig(cfg)}, nil
}

func (p *AWSKMSProvider) EncryptDEK(ctx context.Context, keyID string, dek []byte) ([]byte, error) {
	resp, err := p.client.Encrypt(ctx, &kms.EncryptInput{
		KeyId:     &keyID,
		Plaintext: dek,
		EncryptionAlgorithm: types.EncryptionAlgorithmSpecSymmetricDefault,
	})
	if err != nil {
		return nil, fmt.Errorf("AWSKMSProvider.EncryptDEK: %w", err)
	}
	return resp.CiphertextBlob, nil
}

func (p *AWSKMSProvider) DecryptDEK(ctx context.Context, keyID string, encryptedDEK []byte) ([]byte, error) {
	resp, err := p.client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: encryptedDEK,
		KeyId:          &keyID,
	})
	if err != nil {
		return nil, fmt.Errorf("AWSKMSProvider.DecryptDEK: %w", err)
	}
	return resp.Plaintext, nil
}
```

## GCP KMS Integration

```go
package kms

import (
	"context"
	"fmt"

	kmsapi "cloud.google.com/go/kms/apiv1"
	"cloud.google.com/go/kms/apiv1/kmspb"
	"google.golang.org/api/option"
)

// GCPKMSProvider implements KEKProvider using Google Cloud KMS.
type GCPKMSProvider struct {
	client *kmsapi.KeyManagementClient
}

// NewGCPKMSProvider creates a GCPKMSProvider using Application Default Credentials.
func NewGCPKMSProvider(ctx context.Context) (*GCPKMSProvider, error) {
	client, err := kmsapi.NewKeyManagementClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("NewGCPKMSProvider: %w", err)
	}
	return &GCPKMSProvider{client: client}, nil
}

func (p *GCPKMSProvider) EncryptDEK(ctx context.Context, keyID string, dek []byte) ([]byte, error) {
	// keyID format: projects/<project>/locations/<region>/keyRings/<ring>/cryptoKeys/<key>
	resp, err := p.client.Encrypt(ctx, &kmspb.EncryptRequest{
		Name:      keyID,
		Plaintext: dek,
	})
	if err != nil {
		return nil, fmt.Errorf("GCPKMSProvider.EncryptDEK: %w", err)
	}
	return resp.Ciphertext, nil
}

func (p *GCPKMSProvider) DecryptDEK(ctx context.Context, keyID string, encryptedDEK []byte) ([]byte, error) {
	resp, err := p.client.Decrypt(ctx, &kmspb.DecryptRequest{
		Name:       keyID,
		Ciphertext: encryptedDEK,
	})
	if err != nil {
		return nil, fmt.Errorf("GCPKMSProvider.DecryptDEK: %w", err)
	}
	return resp.Plaintext, nil
}
```

## X.509 Certificate Generation for Internal PKI

Generating self-signed or CA-signed certificates is required for internal mTLS, webhook servers, and development environments:

```go
package crypto

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"time"
)

// CertOptions configures a certificate.
type CertOptions struct {
	Subject     pkix.Name
	DNSNames    []string
	IPAddresses []net.IP
	NotBefore   time.Time
	NotAfter    time.Time
	IsCA        bool
	// KeyUsage and ExtKeyUsage default to sensible values if zero.
	KeyUsage    x509.KeyUsage
	ExtKeyUsage []x509.ExtKeyUsage
}

// GenerateCACertificate generates a self-signed CA certificate and key.
func GenerateCACertificate(opts CertOptions) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateCACertificate: generate key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateCACertificate: serial: %w", err)
	}

	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               opts.Subject,
		NotBefore:             opts.NotBefore,
		NotAfter:              opts.NotAfter,
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateCACertificate: sign: %w", err)
	}

	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateCACertificate: marshal key: %w", err)
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})

	return certPEM, keyPEM, nil
}

// GenerateServerCertificate generates a TLS server certificate signed by caCert/caKey.
func GenerateServerCertificate(
	caCertPEM, caKeyPEM []byte,
	opts CertOptions,
) (certPEM, keyPEM []byte, err error) {
	// Parse CA certificate and key.
	caBlock, _ := pem.Decode(caCertPEM)
	if caBlock == nil {
		return nil, nil, fmt.Errorf("GenerateServerCertificate: invalid CA certificate PEM")
	}
	caCert, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateServerCertificate: parse CA cert: %w", err)
	}

	caKeyBlock, _ := pem.Decode(caKeyPEM)
	if caKeyBlock == nil {
		return nil, nil, fmt.Errorf("GenerateServerCertificate: invalid CA key PEM")
	}
	caKeyIface, err := x509.ParsePKCS8PrivateKey(caKeyBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateServerCertificate: parse CA key: %w", err)
	}
	caKey, ok := caKeyIface.(*ecdsa.PrivateKey)
	if !ok {
		return nil, nil, fmt.Errorf("GenerateServerCertificate: CA key must be ECDSA")
	}

	// Generate the server key.
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateServerCertificate: generate server key: %w", err)
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))

	keyUsage := opts.KeyUsage
	if keyUsage == 0 {
		keyUsage = x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment
	}

	extKeyUsage := opts.ExtKeyUsage
	if len(extKeyUsage) == 0 {
		extKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}

	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      opts.Subject,
		DNSNames:     opts.DNSNames,
		IPAddresses:  opts.IPAddresses,
		NotBefore:    opts.NotBefore,
		NotAfter:     opts.NotAfter,
		KeyUsage:     keyUsage,
		ExtKeyUsage:  extKeyUsage,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, caCert, &serverKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateServerCertificate: sign: %w", err)
	}

	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	keyDER, err := x509.MarshalPKCS8PrivateKey(serverKey)
	if err != nil {
		return nil, nil, fmt.Errorf("GenerateServerCertificate: marshal key: %w", err)
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})

	return certPEM, keyPEM, nil
}
```

## Constant-Time Comparisons

When comparing secrets (tokens, MACs), always use constant-time comparison to prevent timing attacks:

```go
package crypto

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// SecureCompare performs a constant-time comparison of two byte slices.
// Returns true only if they are equal in both length and content.
// Uses crypto/subtle.ConstantTimeCompare internally via hmac.Equal.
func SecureCompare(a, b []byte) bool {
	return hmac.Equal(a, b)
}

// HMACSHA256 computes the HMAC-SHA256 of data using the given key.
func HMACSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

// VerifyHMACSHA256 verifies a HMAC-SHA256 in constant time.
func VerifyHMACSHA256(key, data, expectedMAC []byte) error {
	actualMAC := HMACSHA256(key, data)
	if !hmac.Equal(actualMAC, expectedMAC) {
		return fmt.Errorf("VerifyHMACSHA256: MAC verification failed")
	}
	return nil
}

// HexHMACSHA256 returns the lowercase hex-encoded HMAC-SHA256.
func HexHMACSHA256(key, data []byte) string {
	return hex.EncodeToString(HMACSHA256(key, data))
}
```

## Testing Cryptographic Code

```go
package crypto_test

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"internal.company.com/crypto"
)

func TestAESGCMRoundTrip(t *testing.T) {
	key, err := crypto.GenerateAES256Key()
	require.NoError(t, err)
	require.Len(t, key, 32)

	plaintext := []byte("the quick brown fox jumps over the lazy dog")
	aad := []byte("context:test")

	ciphertext, err := crypto.EncryptAESGCM(key, plaintext, aad)
	require.NoError(t, err)
	assert.NotEqual(t, plaintext, ciphertext)
	// Ciphertext is longer by 12 (nonce) + 16 (tag) bytes
	assert.Equal(t, len(plaintext)+28, len(ciphertext))

	recovered, err := crypto.DecryptAESGCM(key, ciphertext, aad)
	require.NoError(t, err)
	assert.True(t, bytes.Equal(plaintext, recovered))
}

func TestAESGCMAADMismatchFails(t *testing.T) {
	key, _ := crypto.GenerateAES256Key()
	plaintext := []byte("sensitive data")
	aad := []byte("original-context")

	ciphertext, _ := crypto.EncryptAESGCM(key, plaintext, aad)

	// Decryption with different AAD must fail
	_, err := crypto.DecryptAESGCM(key, ciphertext, []byte("different-context"))
	assert.Error(t, err, "decryption with wrong AAD must fail")
}

func TestECDSARoundTrip(t *testing.T) {
	key, err := crypto.GenerateECDSAP256Key()
	require.NoError(t, err)

	data := []byte("document to sign")

	sig, err := crypto.SignECDSA(key, data)
	require.NoError(t, err)

	err = crypto.VerifyECDSA(&key.PublicKey, data, sig)
	assert.NoError(t, err)

	// Tampered data must fail verification
	err = crypto.VerifyECDSA(&key.PublicKey, append(data, 0x00), sig)
	assert.Error(t, err)
}

func TestHKDFDeterminism(t *testing.T) {
	masterKey := make([]byte, 32)
	salt := make([]byte, 32)

	key1, err := crypto.DeriveKey(masterKey, salt, "purpose-a", 32)
	require.NoError(t, err)

	key2, err := crypto.DeriveKey(masterKey, salt, "purpose-a", 32)
	require.NoError(t, err)

	// Same inputs must produce same output
	assert.True(t, bytes.Equal(key1, key2))

	key3, err := crypto.DeriveKey(masterKey, salt, "purpose-b", 32)
	require.NoError(t, err)

	// Different info strings must produce different outputs
	assert.False(t, bytes.Equal(key1, key3))
}
```

## Summary

Production Go cryptography should default to AES-256-GCM for symmetric encryption, ECDSA P-256 for signing, HKDF for key derivation, and envelope encryption with a cloud KMS for key lifecycle management. The patterns in this guide avoid the most common pitfalls: nonce reuse in AES-GCM (use random nonces), unauthenticated encryption (always use AEAD modes), timing attacks in secret comparison (use constant-time functions), and insecure key storage (never persist raw DEKs — always wrap them with KMS). The local testing infrastructure uses the same `KEKProvider` interface with a passthrough implementation, enabling realistic integration tests without cloud credentials in CI.
