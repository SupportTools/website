---
title: "Go Cryptography in Production: AES-GCM Encryption, Ed25519 Signatures, and Key Rotation Patterns"
date: 2028-07-30T00:00:00-05:00
draft: false
tags: ["Go", "Cryptography", "AES", "Ed25519", "Security", "Key Management"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to implementing cryptography in Go correctly: AES-256-GCM authenticated encryption, Ed25519 digital signatures, HKDF key derivation, secure key rotation patterns, and integrating with hardware security modules."
more_link: "yes"
url: "/go-cryptography-production-patterns-guide/"
---

Cryptography is one of the areas where small mistakes have catastrophic consequences. Using ECB mode instead of GCM, reusing a nonce, not verifying a signature before using the data, or rolling your own key derivation function can all result in complete security failures that may not be noticed for years. Go's standard library cryptography packages are excellent and implement the right algorithms, but using them correctly requires understanding what each parameter means and what can go wrong.

This guide covers production-grade cryptographic operations in Go: AES-256-GCM authenticated encryption with proper nonce handling, Ed25519 digital signatures, HKDF-based key derivation for hierarchical key management, secure envelope encryption, key rotation patterns, and integration with AWS KMS as a hardware security module backend.

<!--more-->

# Go Cryptography in Production: Correct Implementation Patterns

## Fundamental Principles

Before writing any cryptographic code, internalize these principles:

1. **Never roll your own crypto**: Use standard library primitives, not custom implementations
2. **Nonces must be unique**: In GCM mode, reusing a nonce with the same key completely breaks confidentiality
3. **Authenticate before decrypting**: Always verify MAC/signature before processing the plaintext
4. **Separate keys by purpose**: Different keys for encryption, signing, and authentication
5. **Derive, don't store**: Use HKDF to derive purpose-specific subkeys from a master key

## Section 1: AES-256-GCM Authenticated Encryption

AES-GCM is the right choice for symmetric encryption in nearly all scenarios. It provides both confidentiality (encryption) and integrity (authentication), so tampering with the ciphertext is detected on decryption.

```go
// pkg/crypto/aes.go
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
)

const (
	// AES-256 requires a 32-byte key.
	AES256KeySize = 32

	// GCM nonce size is 12 bytes.
	GCMNonceSize = 12

	// GCM tag size is 16 bytes.
	GCMTagSize = 16
)

// GenerateKey generates a cryptographically secure random AES-256 key.
func GenerateKey() ([]byte, error) {
	key := make([]byte, AES256KeySize)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}
	return key, nil
}

// Encrypt encrypts plaintext using AES-256-GCM.
// Returns: nonce + ciphertext + tag (all concatenated)
// The nonce is prepended to the output for use during decryption.
//
// Security: a fresh random nonce is generated for every call.
// Never use the same nonce twice with the same key.
func Encrypt(key, plaintext []byte) ([]byte, error) {
	if len(key) != AES256KeySize {
		return nil, fmt.Errorf("key must be %d bytes, got %d", AES256KeySize, len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}

	// Generate a random nonce.
	// GCM nonce must be unique per (key, message) pair.
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}

	// Seal appends the ciphertext and tag to nonce.
	// nonce || ciphertext || tag
	ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}

// EncryptWithAAD encrypts plaintext with additional authenticated data (AAD).
// AAD is authenticated but not encrypted (e.g., metadata that must be plaintext
// but must not be tampered with).
func EncryptWithAAD(key, plaintext, aad []byte) ([]byte, error) {
	if len(key) != AES256KeySize {
		return nil, fmt.Errorf("key must be %d bytes, got %d", AES256KeySize, len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}

	// The AAD is authenticated but not included in the output.
	// The caller must provide the same AAD during decryption.
	ciphertext := gcm.Seal(nonce, nonce, plaintext, aad)
	return ciphertext, nil
}

// Decrypt decrypts ciphertext produced by Encrypt.
// Returns an error if the ciphertext has been tampered with.
func Decrypt(key, ciphertext []byte) ([]byte, error) {
	if len(key) != AES256KeySize {
		return nil, fmt.Errorf("key must be %d bytes, got %d", AES256KeySize, len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize+GCMTagSize {
		return nil, errors.New("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]

	// Open authenticates and decrypts.
	// This returns an error if the tag does not match.
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		// Do not reveal why decryption failed (timing/oracle attacks).
		return nil, errors.New("decryption failed")
	}

	return plaintext, nil
}

// DecryptWithAAD decrypts ciphertext produced by EncryptWithAAD.
func DecryptWithAAD(key, ciphertext, aad []byte) ([]byte, error) {
	if len(key) != AES256KeySize {
		return nil, fmt.Errorf("key must be %d bytes, got %d", AES256KeySize, len(key))
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize+GCMTagSize {
		return nil, errors.New("ciphertext too short")
	}

	nonce, ct := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ct, aad)
	if err != nil {
		return nil, errors.New("decryption failed")
	}

	return plaintext, nil
}
```

## Section 2: HKDF Key Derivation

Never use a single key for multiple purposes. HKDF (HMAC-based Extract-and-Expand Key Derivation Function, RFC 5869) derives multiple purpose-specific keys from a single master key or passphrase.

```go
// pkg/crypto/hkdf.go
package crypto

import (
	"crypto/sha256"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

// DeriveKey derives a key of keyLen bytes from masterKey using HKDF-SHA256.
// The info parameter identifies the purpose of the derived key.
// The salt can be random or a fixed string; it does not need to be secret.
//
// Example usage:
//   encKey, _ := DeriveKey(master, []byte("database:encrypt:v1"), nil, 32)
//   macKey, _ := DeriveKey(master, []byte("database:mac:v1"), nil, 32)
func DeriveKey(masterKey, info, salt []byte, keyLen int) ([]byte, error) {
	if len(masterKey) == 0 {
		return nil, fmt.Errorf("master key must not be empty")
	}

	// HKDF uses SHA-256 as the underlying hash function.
	// info must uniquely identify the key's purpose.
	reader := hkdf.New(sha256.New, masterKey, salt, info)

	derived := make([]byte, keyLen)
	if _, err := io.ReadFull(reader, derived); err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}

	return derived, nil
}

// KeyPurpose constants for standard HKDF derivation paths.
const (
	PurposeEncryption = "encryption:aes-256-gcm:v1"
	PurposeSigning    = "signing:ed25519:v1"
	PurposeMAC        = "mac:hmac-sha256:v1"
)

// KeySet holds a set of derived keys for a specific context.
// All keys are derived from a single master key using HKDF.
type KeySet struct {
	EncryptionKey []byte
	SigningKey     []byte
	MACKey        []byte
}

// DeriveKeySet derives all keys in a KeySet from a master key.
// The context string (e.g., "user:12345:v1") scopes the keys to a specific entity.
func DeriveKeySet(masterKey []byte, context string) (*KeySet, error) {
	encKey, err := DeriveKey(masterKey,
		[]byte(PurposeEncryption+":"+context), nil, AES256KeySize)
	if err != nil {
		return nil, fmt.Errorf("derive encryption key: %w", err)
	}

	sigKey, err := DeriveKey(masterKey,
		[]byte(PurposeSigning+":"+context), nil, 32)
	if err != nil {
		return nil, fmt.Errorf("derive signing key: %w", err)
	}

	macKey, err := DeriveKey(masterKey,
		[]byte(PurposeMAC+":"+context), nil, 32)
	if err != nil {
		return nil, fmt.Errorf("derive MAC key: %w", err)
	}

	return &KeySet{
		EncryptionKey: encKey,
		SigningKey:     sigKey,
		MACKey:        macKey,
	}, nil
}
```

## Section 3: Ed25519 Digital Signatures

Ed25519 is the recommended digital signature algorithm for new systems. It is faster than RSA, produces small signatures (64 bytes), and does not require careful parameter selection.

```go
// pkg/crypto/ed25519.go
package crypto

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
)

// GenerateSigningKeyPair generates a new Ed25519 key pair.
func GenerateSigningKeyPair() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate Ed25519 key pair: %w", err)
	}
	return pub, priv, nil
}

// Sign signs the message with the private key.
// Ed25519 does not require pre-hashing the message.
func Sign(privateKey ed25519.PrivateKey, message []byte) ([]byte, error) {
	if len(privateKey) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid private key size: %d", len(privateKey))
	}
	return ed25519.Sign(privateKey, message), nil
}

// Verify verifies the signature against the public key and message.
// Returns nil if the signature is valid.
func Verify(publicKey ed25519.PublicKey, message, signature []byte) error {
	if len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid public key size: %d", len(publicKey))
	}
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("invalid signature size: %d", len(signature))
	}
	if !ed25519.Verify(publicKey, message, signature) {
		return errors.New("signature verification failed")
	}
	return nil
}

// MarshalPrivateKeyPEM encodes an Ed25519 private key as PEM.
func MarshalPrivateKeyPEM(key ed25519.PrivateKey) ([]byte, error) {
	// Ed25519 private key in PKCS8 format.
	block := &pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: key.Seed(), // The seed is the canonical form.
	}
	return pem.EncodeToMemory(block), nil
}

// MarshalPublicKeyPEM encodes an Ed25519 public key as PEM.
func MarshalPublicKeyPEM(key ed25519.PublicKey) ([]byte, error) {
	block := &pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: []byte(key),
	}
	return pem.EncodeToMemory(block), nil
}

// Signer provides signing operations using an Ed25519 private key.
type Signer struct {
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
}

// NewSigner creates a Signer from an existing private key.
func NewSigner(privateKey ed25519.PrivateKey) *Signer {
	return &Signer{
		privateKey: privateKey,
		publicKey:  privateKey.Public().(ed25519.PublicKey),
	}
}

// Sign signs the message and returns the signature.
func (s *Signer) Sign(message []byte) []byte {
	return ed25519.Sign(s.privateKey, message)
}

// PublicKey returns the public key for verification.
func (s *Signer) PublicKey() ed25519.PublicKey {
	return s.publicKey
}

// Verifier provides verification operations.
type Verifier struct {
	publicKey ed25519.PublicKey
}

// NewVerifier creates a Verifier from a public key.
func NewVerifier(publicKey ed25519.PublicKey) *Verifier {
	return &Verifier{publicKey: publicKey}
}

// Verify verifies the signature.
func (v *Verifier) Verify(message, signature []byte) bool {
	return ed25519.Verify(v.publicKey, message, signature)
}
```

## Section 4: Envelope Encryption

Envelope encryption is the industry-standard pattern for encrypting large amounts of data with a key hierarchy:

1. Generate a random data encryption key (DEK) for each piece of data
2. Encrypt the data with the DEK
3. Encrypt the DEK with a key encryption key (KEK), typically managed by a KMS
4. Store the encrypted DEK alongside the encrypted data

```go
// pkg/crypto/envelope.go
package crypto

import (
	"encoding/json"
	"fmt"
)

// EncryptedEnvelope holds all the data needed to decrypt a message.
type EncryptedEnvelope struct {
	// EncryptedDEK is the data encryption key, encrypted with the KEK.
	EncryptedDEK []byte `json:"encrypted_dek"`

	// Ciphertext is the actual data, encrypted with the DEK.
	Ciphertext []byte `json:"ciphertext"`

	// KeyID identifies which KEK was used to encrypt the DEK.
	// Used during rotation to know which key version to use for decryption.
	KeyID string `json:"key_id"`

	// Algorithm identifies the encryption algorithm used.
	Algorithm string `json:"algorithm"`
}

// KEKProvider is an interface for a key encryption key provider.
// This can be a local in-memory key, AWS KMS, GCP KMS, or Vault.
type KEKProvider interface {
	// Encrypt encrypts plaintext using the current key.
	// Returns the ciphertext and the key ID used.
	Encrypt(plaintext []byte) (ciphertext []byte, keyID string, err error)

	// Decrypt decrypts ciphertext that was encrypted with the specified keyID.
	Decrypt(keyID string, ciphertext []byte) (plaintext []byte, err error)
}

// EnvelopeEncryptor encrypts and decrypts data using envelope encryption.
type EnvelopeEncryptor struct {
	kek KEKProvider
}

// NewEnvelopeEncryptor creates a new EnvelopeEncryptor.
func NewEnvelopeEncryptor(kek KEKProvider) *EnvelopeEncryptor {
	return &EnvelopeEncryptor{kek: kek}
}

// Encrypt encrypts plaintext using envelope encryption.
func (e *EnvelopeEncryptor) Encrypt(plaintext []byte) ([]byte, error) {
	// Generate a random DEK.
	dek, err := GenerateKey()
	if err != nil {
		return nil, fmt.Errorf("generate DEK: %w", err)
	}
	defer wipeKey(dek) // Zero the DEK after use.

	// Encrypt the data with the DEK.
	ciphertext, err := Encrypt(dek, plaintext)
	if err != nil {
		return nil, fmt.Errorf("encrypt data: %w", err)
	}

	// Encrypt the DEK with the KEK.
	encryptedDEK, keyID, err := e.kek.Encrypt(dek)
	if err != nil {
		return nil, fmt.Errorf("encrypt DEK: %w", err)
	}

	envelope := &EncryptedEnvelope{
		EncryptedDEK: encryptedDEK,
		Ciphertext:   ciphertext,
		KeyID:        keyID,
		Algorithm:    "AES-256-GCM",
	}

	return json.Marshal(envelope)
}

// Decrypt decrypts an envelope-encrypted ciphertext.
func (e *EnvelopeEncryptor) Decrypt(envelopeData []byte) ([]byte, error) {
	var envelope EncryptedEnvelope
	if err := json.Unmarshal(envelopeData, &envelope); err != nil {
		return nil, fmt.Errorf("unmarshal envelope: %w", err)
	}

	// Decrypt the DEK using the KEK.
	dek, err := e.kek.Decrypt(envelope.KeyID, envelope.EncryptedDEK)
	if err != nil {
		return nil, fmt.Errorf("decrypt DEK: %w", err)
	}
	defer wipeKey(dek)

	// Decrypt the data with the DEK.
	plaintext, err := Decrypt(dek, envelope.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decrypt data: %w", err)
	}

	return plaintext, nil
}

// wipeKey zeroes a key buffer after use.
func wipeKey(key []byte) {
	for i := range key {
		key[i] = 0
	}
}
```

## Section 5: AWS KMS Integration

```go
// pkg/crypto/kms/aws.go
package kms

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"
)

// AWSKMSProvider implements KEKProvider using AWS KMS.
type AWSKMSProvider struct {
	client *kms.Client
	keyARN string
}

// NewAWSKMSProvider creates a new AWS KMS key provider.
func NewAWSKMSProvider(ctx context.Context, keyARN string) (*AWSKMSProvider, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}

	return &AWSKMSProvider{
		client: kms.NewFromConfig(cfg),
		keyARN: keyARN,
	}, nil
}

// Encrypt encrypts plaintext using AWS KMS.
func (p *AWSKMSProvider) Encrypt(plaintext []byte) ([]byte, string, error) {
	result, err := p.client.Encrypt(context.Background(), &kms.EncryptInput{
		KeyId:               &p.keyARN,
		Plaintext:           plaintext,
		EncryptionAlgorithm: types.EncryptionAlgorithmSpecSymmetricDefault,
	})
	if err != nil {
		return nil, "", fmt.Errorf("KMS encrypt: %w", err)
	}

	return result.CiphertextBlob, *result.KeyId, nil
}

// Decrypt decrypts ciphertext using AWS KMS.
func (p *AWSKMSProvider) Decrypt(keyID string, ciphertext []byte) ([]byte, error) {
	result, err := p.client.Decrypt(context.Background(), &kms.DecryptInput{
		CiphertextBlob:      ciphertext,
		KeyId:               &keyID,
		EncryptionAlgorithm: types.EncryptionAlgorithmSpecSymmetricDefault,
	})
	if err != nil {
		return nil, fmt.Errorf("KMS decrypt: %w", err)
	}

	return result.Plaintext, nil
}

// GenerateDataKey uses AWS KMS to generate a data key, returning both
// the plaintext key (for immediate use) and the encrypted key (for storage).
// This is more efficient than calling Encrypt/Decrypt for large datasets
// because you only make one KMS API call per dataset.
func (p *AWSKMSProvider) GenerateDataKey(ctx context.Context) (
	plaintextKey []byte, encryptedKey []byte, err error,
) {
	result, err := p.client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId:   &p.keyARN,
		KeySpec: types.DataKeySpecAes256,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("KMS generate data key: %w", err)
	}

	return result.Plaintext, result.CiphertextBlob, nil
}
```

## Section 6: Key Rotation

Key rotation is the process of retiring old keys and issuing new ones without data loss. Envelope encryption makes key rotation efficient: you only need to re-encrypt the DEK, not the data itself.

```go
// pkg/crypto/rotation.go
package crypto

import (
	"fmt"
	"sync"
	"time"
)

// KeyVersion holds a versioned key and its metadata.
type KeyVersion struct {
	ID        string
	Key       []byte
	CreatedAt time.Time
	ExpiresAt time.Time
	Status    KeyStatus
}

// KeyStatus indicates whether a key is active, read-only, or revoked.
type KeyStatus int

const (
	KeyStatusActive   KeyStatus = iota
	KeyStatusReadOnly           // Can decrypt but not encrypt.
	KeyStatusRevoked            // Cannot be used at all.
)

// KeyRing manages multiple key versions and supports rotation.
type KeyRing struct {
	mu       sync.RWMutex
	versions map[string]*KeyVersion
	current  string // ID of the current active key.
}

// NewKeyRing creates a new key ring with an initial key.
func NewKeyRing() (*KeyRing, error) {
	kr := &KeyRing{
		versions: make(map[string]*KeyVersion),
	}
	if _, err := kr.Rotate(); err != nil {
		return nil, err
	}
	return kr, nil
}

// Rotate generates a new key and makes it the active encryption key.
// The old key is set to read-only (can still decrypt).
func (kr *KeyRing) Rotate() (string, error) {
	newKey, err := GenerateKey()
	if err != nil {
		return "", fmt.Errorf("generate key: %w", err)
	}

	kr.mu.Lock()
	defer kr.mu.Unlock()

	// Demote the current key to read-only.
	if kr.current != "" {
		if old, ok := kr.versions[kr.current]; ok {
			old.Status = KeyStatusReadOnly
		}
	}

	id := generateKeyID()
	kr.versions[id] = &KeyVersion{
		ID:        id,
		Key:       newKey,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour), // 90-day expiry.
		Status:    KeyStatusActive,
	}
	kr.current = id

	return id, nil
}

// Current returns the current active key version.
func (kr *KeyRing) Current() (*KeyVersion, error) {
	kr.mu.RLock()
	defer kr.mu.RUnlock()

	v, ok := kr.versions[kr.current]
	if !ok {
		return nil, fmt.Errorf("no active key")
	}
	return v, nil
}

// Get retrieves a specific key version for decryption.
func (kr *KeyRing) Get(id string) (*KeyVersion, error) {
	kr.mu.RLock()
	defer kr.mu.RUnlock()

	v, ok := kr.versions[id]
	if !ok {
		return nil, fmt.Errorf("key version %s not found", id)
	}
	if v.Status == KeyStatusRevoked {
		return nil, fmt.Errorf("key version %s has been revoked", id)
	}
	return v, nil
}

// Encrypt encrypts data with the current active key.
func (kr *KeyRing) Encrypt(plaintext []byte) (ciphertext []byte, keyID string, err error) {
	current, err := kr.Current()
	if err != nil {
		return nil, "", err
	}

	ct, err := Encrypt(current.Key, plaintext)
	if err != nil {
		return nil, "", err
	}

	return ct, current.ID, nil
}

// Decrypt decrypts data using the specified key version.
func (kr *KeyRing) Decrypt(keyID string, ciphertext []byte) ([]byte, error) {
	version, err := kr.Get(keyID)
	if err != nil {
		return nil, err
	}

	return Decrypt(version.Key, ciphertext)
}

func generateKeyID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return fmt.Sprintf("key-%x", b)
}
```

## Section 7: Secure Token Generation

Many systems need to generate tokens, session IDs, API keys, and similar values. These must be cryptographically random:

```go
// pkg/crypto/tokens.go
package crypto

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
)

// TokenConfig defines the parameters for token generation.
type TokenConfig struct {
	ByteLength int    // Number of random bytes.
	Prefix     string // Optional prefix (e.g., "sk_live_").
}

// Common token configurations.
var (
	APIKeyConfig     = TokenConfig{ByteLength: 32, Prefix: "sk_"}
	SessionIDConfig  = TokenConfig{ByteLength: 32, Prefix: ""}
	CSRFTokenConfig  = TokenConfig{ByteLength: 32, Prefix: ""}
	PasswordResetConfig = TokenConfig{ByteLength: 48, Prefix: "reset_"}
)

// GenerateToken generates a URL-safe base64-encoded random token.
func GenerateToken(cfg TokenConfig) (string, error) {
	b := make([]byte, cfg.ByteLength)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	if cfg.Prefix != "" {
		return cfg.Prefix + token, nil
	}
	return token, nil
}

// SplitToken splits a prefixed token into prefix and token parts.
func SplitToken(token, prefix string) (string, bool) {
	if !strings.HasPrefix(token, prefix) {
		return "", false
	}
	return strings.TrimPrefix(token, prefix), true
}

// ConstantTimeEquals compares two strings in constant time to prevent
// timing attacks. Always use this instead of == when comparing secrets.
func ConstantTimeEquals(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var x byte
	for i := 0; i < len(a); i++ {
		x |= a[i] ^ b[i]
	}
	return x == 0
}
```

## Section 8: Password Hashing

Passwords must never be stored as plaintext or with reversible encryption. Use Argon2id (the winner of the Password Hashing Competition) for new systems:

```go
// pkg/crypto/password.go
package crypto

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2Params defines the parameters for Argon2id password hashing.
// These values are intentionally conservative and should be tuned based
// on the available hardware.
type Argon2Params struct {
	Memory      uint32 // Memory in KiB. Recommended: 64 MiB.
	Iterations  uint32 // Number of iterations. Recommended: 3.
	Parallelism uint8  // Degree of parallelism. Recommended: 2.
	SaltLength  uint32 // Salt length in bytes. Recommended: 16.
	KeyLength   uint32 // Output key length in bytes. Recommended: 32.
}

// DefaultArgon2Params provides safe defaults for password hashing.
var DefaultArgon2Params = Argon2Params{
	Memory:      64 * 1024, // 64 MiB
	Iterations:  3,
	Parallelism: 2,
	SaltLength:  16,
	KeyLength:   32,
}

// HashPassword hashes a password using Argon2id.
// Returns an encoded string containing the hash, salt, and parameters.
func HashPassword(password string, params Argon2Params) (string, error) {
	salt := make([]byte, params.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	hash := argon2.IDKey(
		[]byte(password),
		salt,
		params.Iterations,
		params.Memory,
		params.Parallelism,
		params.KeyLength,
	)

	// Encode as: $argon2id$v=19$m=65536,t=3,p=2$salt$hash
	encoded := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		params.Memory,
		params.Iterations,
		params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	)

	return encoded, nil
}

// VerifyPassword verifies a password against an encoded hash.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 {
		return false, errors.New("invalid hash format")
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, fmt.Errorf("parse version: %w", err)
	}
	if version != argon2.Version {
		return false, fmt.Errorf("unsupported argon2 version: %d", version)
	}

	var params Argon2Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d",
		&params.Memory, &params.Iterations, &params.Parallelism); err != nil {
		return false, fmt.Errorf("parse params: %w", err)
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("decode salt: %w", err)
	}

	storedHash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("decode hash: %w", err)
	}

	params.KeyLength = uint32(len(storedHash))

	computedHash := argon2.IDKey(
		[]byte(password),
		salt,
		params.Iterations,
		params.Memory,
		params.Parallelism,
		params.KeyLength,
	)

	// Use constant-time comparison to prevent timing attacks.
	return subtle.ConstantTimeCompare(storedHash, computedHash) == 1, nil
}
```

## Section 9: Testing Cryptographic Code

```go
// pkg/crypto/aes_test.go
package crypto_test

import (
	"bytes"
	"testing"

	"github.com/example/auth/pkg/crypto"
)

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	plaintext := []byte("hello, world! this is a test message.")

	ciphertext, err := crypto.Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	if bytes.Equal(ciphertext, plaintext) {
		t.Fatal("ciphertext equals plaintext")
	}

	decrypted, err := crypto.Decrypt(key, ciphertext)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}

	if !bytes.Equal(decrypted, plaintext) {
		t.Errorf("decrypted mismatch: got %q, want %q", decrypted, plaintext)
	}
}

func TestEncrypt_UniqueNonces(t *testing.T) {
	key, _ := crypto.GenerateKey()
	plaintext := []byte("same message")

	ct1, _ := crypto.Encrypt(key, plaintext)
	ct2, _ := crypto.Encrypt(key, plaintext)

	// Encrypting the same message twice must produce different ciphertexts
	// (due to unique random nonces).
	if bytes.Equal(ct1, ct2) {
		t.Fatal("two encryptions of the same plaintext produced identical ciphertexts")
	}
}

func TestDecrypt_TamperDetection(t *testing.T) {
	key, _ := crypto.GenerateKey()
	ciphertext, _ := crypto.Encrypt(key, []byte("test data"))

	// Flip a bit in the middle of the ciphertext.
	tampered := make([]byte, len(ciphertext))
	copy(tampered, ciphertext)
	tampered[len(tampered)/2] ^= 0x01

	_, err := crypto.Decrypt(key, tampered)
	if err == nil {
		t.Fatal("expected decryption to fail on tampered ciphertext")
	}
}

func BenchmarkEncrypt_1KB(b *testing.B) {
	key, _ := crypto.GenerateKey()
	plaintext := make([]byte, 1024)
	b.ResetTimer()
	b.SetBytes(1024)
	for i := 0; i < b.N; i++ {
		_, _ = crypto.Encrypt(key, plaintext)
	}
}
```

## Section 10: Security Checklist

**Key Management**
- Never hardcode keys in source code or configuration files
- Derive subkeys using HKDF rather than using a single key for multiple purposes
- Store keys in a secure key management system (AWS KMS, HashiCorp Vault, GCP KMS)
- Implement key rotation with a maximum key lifetime of 90 days for data encryption keys
- Log all key operations (but never log the keys themselves)

**Encryption**
- Use AES-256-GCM for symmetric encryption (not AES-CBC, not AES-ECB)
- Generate a fresh random nonce for every encryption operation
- Never reuse (key, nonce) pairs — this completely breaks GCM security
- Use envelope encryption for large datasets or datasets that need to be re-encrypted during key rotation

**Signing**
- Use Ed25519 for new signing systems
- Use RSA-PSS (not PKCS1v15) if RSA is required for compatibility
- Verify signatures before processing any data from untrusted sources
- Include a timestamp in signed data to prevent replay attacks

**Passwords**
- Use Argon2id for password hashing
- Never use MD5, SHA-1, SHA-256, or bcrypt for new systems
- Use constant-time comparison when checking passwords and tokens
- Implement account lockout after repeated failures

**Randomness**
- Always use `crypto/rand`, never `math/rand`, for security-sensitive random data
- Use `io.ReadFull(rand.Reader, ...)` to ensure you get all the bytes you need

## Conclusion

Correct cryptography in Go requires understanding not just which functions to call, but why each design decision matters. AES-GCM provides authenticated encryption; the nonce must be unique or everything breaks. HKDF separates keys by purpose so that a compromise of one key does not compromise others. Ed25519 is fast, safe, and requires no parameter tuning. Envelope encryption makes key rotation efficient and separates the key management lifecycle from the data lifecycle.

The implementations in this guide follow the principle of using well-audited standard library primitives, being explicit about what can go wrong, and testing failure cases as rigorously as success cases. Cryptography that only works when everything goes right is not production cryptography.
