---
title: "Go Cryptography: AES-GCM, RSA-OAEP, and Elliptic Curve Patterns"
date: 2029-11-11T00:00:00-05:00
draft: false
tags: ["Go", "Cryptography", "AES-GCM", "RSA", "ECDH", "ECDSA", "Security", "TLS"]
categories:
- Go
- Security
- Cryptography
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-ready Go cryptography patterns: AES-GCM authenticated encryption, RSA key generation and OAEP encryption, ECDH key exchange, ECDSA signing and verification, secure random generation, and common pitfalls."
more_link: "yes"
url: "/go-cryptography-aes-gcm-rsa-oaep-elliptic-curve/"
---

Go's standard library provides excellent cryptographic primitives in the `crypto` package hierarchy. Using them correctly, however, requires understanding the security properties of each algorithm, the failure modes of incorrect usage, and the operational considerations for production systems. This post covers production-ready patterns for symmetric encryption, asymmetric encryption, digital signatures, and key exchange.

<!--more-->

# Go Cryptography: AES-GCM, RSA-OAEP, and Elliptic Curve Patterns

## Secure Random Number Generation

All cryptographic operations depend on a secure random number generator. Go's `crypto/rand` package wraps the OS CSPRNG:

```go
package crypto

import (
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "io"
    "math/big"
)

// GenerateRandomBytes generates cryptographically secure random bytes
func GenerateRandomBytes(n int) ([]byte, error) {
    b := make([]byte, n)
    if _, err := io.ReadFull(rand.Reader, b); err != nil {
        return nil, fmt.Errorf("generating random bytes: %w", err)
    }
    return b, nil
}

// GenerateRandomHex generates a random hex string of length n bytes (2n hex chars)
func GenerateRandomHex(n int) (string, error) {
    b, err := GenerateRandomBytes(n)
    if err != nil {
        return "", err
    }
    return hex.EncodeToString(b), nil
}

// GenerateSecureToken generates a URL-safe random token
func GenerateSecureToken(n int) (string, error) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    result := make([]byte, n)
    for i := range result {
        idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
        if err != nil {
            return "", fmt.Errorf("generating token: %w", err)
        }
        result[i] = chars[idx.Int64()]
    }
    return string(result), nil
}

// ConstantTimeEqual compares two byte slices in constant time (prevent timing attacks)
func ConstantTimeEqual(a, b []byte) bool {
    if len(a) != len(b) {
        return false
    }
    var diff byte
    for i := range a {
        diff |= a[i] ^ b[i]
    }
    return diff == 0
}

// NEVER use math/rand for cryptographic purposes:
// import "math/rand"  // WRONG for crypto
// rand.Read(b)        // WRONG: not cryptographically secure
```

## AES-GCM: Authenticated Symmetric Encryption

AES-GCM (Galois/Counter Mode) is the recommended symmetric encryption mode. It provides:
- **Confidentiality**: Data is encrypted
- **Authenticity**: Tampering with ciphertext or associated data is detected
- **Nonce**: Must be unique for every encryption with the same key (never reuse!)

### Key Derivation and Key Management

```go
package crypto

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "crypto/sha256"
    "encoding/base64"
    "errors"
    "fmt"
    "io"

    "golang.org/x/crypto/argon2"
    "golang.org/x/crypto/hkdf"
)

// DeriveKey derives an AES-256 key from a password using Argon2id
func DeriveKey(password []byte, salt []byte) ([]byte, error) {
    if len(salt) < 16 {
        return nil, errors.New("salt must be at least 16 bytes")
    }

    // Argon2id parameters (OWASP recommended for 2024)
    // Time: 3 iterations
    // Memory: 64MB
    // Parallelism: 4
    // Key length: 32 bytes (AES-256)
    key := argon2.IDKey(password, salt, 3, 64*1024, 4, 32)
    return key, nil
}

// DeriveSubkey derives a subkey from a master key using HKDF-SHA256
// Use this to derive purpose-specific keys from a single master key
func DeriveSubkey(masterKey []byte, info string, length int) ([]byte, error) {
    if len(masterKey) < 32 {
        return nil, errors.New("master key must be at least 32 bytes")
    }

    hkdfReader := hkdf.New(sha256.New, masterKey, nil, []byte(info))
    subkey := make([]byte, length)
    if _, err := io.ReadFull(hkdfReader, subkey); err != nil {
        return nil, fmt.Errorf("deriving subkey: %w", err)
    }
    return subkey, nil
}
```

### AES-GCM Encryption/Decryption

```go
// AESGCMKey wraps an AES-GCM cipher with safe encrypt/decrypt operations
type AESGCMKey struct {
    key    []byte
    cipher cipher.AEAD
}

// NewAESGCMKey creates a new AES-GCM cipher from a 32-byte key (AES-256)
func NewAESGCMKey(key []byte) (*AESGCMKey, error) {
    if len(key) != 32 {
        return nil, fmt.Errorf("AES-256 requires 32-byte key, got %d", len(key))
    }

    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, fmt.Errorf("creating AES cipher: %w", err)
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, fmt.Errorf("creating GCM: %w", err)
    }

    keyCopy := make([]byte, len(key))
    copy(keyCopy, key)

    return &AESGCMKey{key: keyCopy, cipher: gcm}, nil
}

// Encrypt encrypts plaintext with optional additional authenticated data (AAD).
// Returns nonce || ciphertext || tag (all in one slice).
// AAD is authenticated but not encrypted (useful for metadata).
func (k *AESGCMKey) Encrypt(plaintext, additionalData []byte) ([]byte, error) {
    // Generate random nonce (12 bytes for GCM standard nonce size)
    nonce := make([]byte, k.cipher.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, fmt.Errorf("generating nonce: %w", err)
    }

    // Seal appends ciphertext and 16-byte GCM tag to nonce
    // Output: nonce(12) || ciphertext(n) || tag(16)
    ciphertext := k.cipher.Seal(nonce, nonce, plaintext, additionalData)
    return ciphertext, nil
}

// Decrypt decrypts ciphertext produced by Encrypt.
// Returns error if authentication fails (tampering detected).
func (k *AESGCMKey) Decrypt(ciphertext, additionalData []byte) ([]byte, error) {
    nonceSize := k.cipher.NonceSize()
    if len(ciphertext) < nonceSize+k.cipher.Overhead() {
        return nil, errors.New("ciphertext too short")
    }

    nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]

    plaintext, err := k.cipher.Open(nil, nonce, ciphertext, additionalData)
    if err != nil {
        // Don't reveal details about why decryption failed
        return nil, errors.New("decryption failed")
    }

    return plaintext, nil
}

// EncryptString encrypts a string and returns base64-encoded ciphertext
func (k *AESGCMKey) EncryptString(plaintext string) (string, error) {
    ct, err := k.Encrypt([]byte(plaintext), nil)
    if err != nil {
        return "", err
    }
    return base64.StdEncoding.EncodeToString(ct), nil
}

// DecryptString decrypts a base64-encoded ciphertext string
func (k *AESGCMKey) DecryptString(ciphertext string) (string, error) {
    ct, err := base64.StdEncoding.DecodeString(ciphertext)
    if err != nil {
        return "", fmt.Errorf("decoding ciphertext: %w", err)
    }
    pt, err := k.Decrypt(ct, nil)
    if err != nil {
        return "", err
    }
    return string(pt), nil
}

// Wipe overwrites the key in memory
func (k *AESGCMKey) Wipe() {
    for i := range k.key {
        k.key[i] = 0
    }
}
```

### AES-GCM-SIV for Nonce Misuse Resistance

When there's any risk of nonce reuse, use AES-GCM-SIV (SIV = Synthetic IV):

```go
// Note: Go 1.21+ or golang.org/x/crypto for GCM-SIV
import "golang.org/x/crypto/chacha20poly1305"

// ChaCha20-Poly1305 is an alternative to AES-GCM with better side-channel resistance
type ChaCha20Key struct {
    aead cipher.AEAD
}

func NewChaCha20Key(key []byte) (*ChaCha20Key, error) {
    if len(key) != chacha20poly1305.KeySize {
        return nil, fmt.Errorf("ChaCha20 requires %d-byte key", chacha20poly1305.KeySize)
    }

    aead, err := chacha20poly1305.New(key)
    if err != nil {
        return nil, err
    }
    return &ChaCha20Key{aead: aead}, nil
}

// NewXChaCha20Key uses XChaCha20-Poly1305 with extended 24-byte nonces
// Safer for random nonces (2^96 space vs 2^32 collision probability)
func NewXChaCha20Key(key []byte) (*ChaCha20Key, error) {
    aead, err := chacha20poly1305.NewX(key)
    if err != nil {
        return nil, err
    }
    return &ChaCha20Key{aead: aead}, nil
}

func (k *ChaCha20Key) Encrypt(plaintext, additionalData []byte) ([]byte, error) {
    nonce := make([]byte, k.aead.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }
    return k.aead.Seal(nonce, nonce, plaintext, additionalData), nil
}

func (k *ChaCha20Key) Decrypt(ciphertext, additionalData []byte) ([]byte, error) {
    ns := k.aead.NonceSize()
    if len(ciphertext) < ns {
        return nil, errors.New("ciphertext too short")
    }
    return k.aead.Open(nil, ciphertext[:ns], ciphertext[ns:], additionalData)
}
```

## RSA Key Generation and OAEP Encryption

RSA should only be used for key encapsulation or small data. For bulk data, use hybrid encryption (RSA encrypts the symmetric key, AES-GCM encrypts the data).

```go
package crypto

import (
    "crypto"
    "crypto/rand"
    "crypto/rsa"
    "crypto/sha256"
    "crypto/x509"
    "encoding/pem"
    "errors"
    "fmt"
)

const (
    RSAKeySize2048 = 2048
    RSAKeySize4096 = 4096
)

// GenerateRSAKeyPair generates a new RSA key pair
func GenerateRSAKeyPair(bits int) (*rsa.PrivateKey, error) {
    if bits < 2048 {
        return nil, errors.New("RSA key size must be at least 2048 bits")
    }

    key, err := rsa.GenerateKey(rand.Reader, bits)
    if err != nil {
        return nil, fmt.Errorf("generating RSA key: %w", err)
    }
    return key, nil
}

// RSAKeyPairToPEM serializes an RSA key pair to PEM format
func RSAKeyPairToPEM(priv *rsa.PrivateKey) (privPEM, pubPEM []byte) {
    privBytes := x509.MarshalPKCS1PrivateKey(priv)
    privPEM = pem.EncodeToMemory(&pem.Block{
        Type:  "RSA PRIVATE KEY",
        Bytes: privBytes,
    })

    pubBytes, _ := x509.MarshalPKIXPublicKey(&priv.PublicKey)
    pubPEM = pem.EncodeToMemory(&pem.Block{
        Type:  "PUBLIC KEY",
        Bytes: pubBytes,
    })

    return privPEM, pubPEM
}

// ParseRSAPrivateKey parses a PEM-encoded RSA private key
func ParseRSAPrivateKey(privPEM []byte) (*rsa.PrivateKey, error) {
    block, _ := pem.Decode(privPEM)
    if block == nil {
        return nil, errors.New("failed to decode PEM block")
    }

    switch block.Type {
    case "RSA PRIVATE KEY":
        return x509.ParsePKCS1PrivateKey(block.Bytes)
    case "PRIVATE KEY":
        key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
        if err != nil {
            return nil, err
        }
        rsaKey, ok := key.(*rsa.PrivateKey)
        if !ok {
            return nil, errors.New("not an RSA key")
        }
        return rsaKey, nil
    default:
        return nil, fmt.Errorf("unsupported PEM type: %s", block.Type)
    }
}

// RSAEncryptOAEP encrypts data using RSA-OAEP with SHA-256
// Maximum plaintext size = key_size_bytes - 2*hash_size - 2
// For RSA-2048 with SHA-256: max 190 bytes
// For RSA-4096 with SHA-256: max 446 bytes
func RSAEncryptOAEP(pubKey *rsa.PublicKey, plaintext, label []byte) ([]byte, error) {
    hash := sha256.New()
    maxLen := pubKey.Size() - 2*hash.Size() - 2

    if len(plaintext) > maxLen {
        return nil, fmt.Errorf("plaintext too large: %d > %d max bytes", len(plaintext), maxLen)
    }

    ciphertext, err := rsa.EncryptOAEP(hash, rand.Reader, pubKey, plaintext, label)
    if err != nil {
        return nil, fmt.Errorf("RSA-OAEP encryption: %w", err)
    }
    return ciphertext, nil
}

// RSADecryptOAEP decrypts RSA-OAEP ciphertext
func RSADecryptOAEP(privKey *rsa.PrivateKey, ciphertext, label []byte) ([]byte, error) {
    hash := sha256.New()
    plaintext, err := rsa.DecryptOAEP(hash, rand.Reader, privKey, ciphertext, label)
    if err != nil {
        // Constant-time error to prevent oracle attacks
        return nil, errors.New("decryption failed")
    }
    return plaintext, nil
}
```

### Hybrid Encryption (RSA + AES-GCM)

```go
// HybridEncrypt encrypts arbitrary-size data using hybrid encryption:
// 1. Generate random AES-256 key
// 2. Encrypt the AES key with RSA-OAEP
// 3. Encrypt the data with AES-GCM
//
// Output format:
// [4 bytes: encrypted_key_length] [encrypted_key] [ciphertext]
func HybridEncrypt(pubKey *rsa.PublicKey, plaintext []byte) ([]byte, error) {
    // Generate ephemeral AES-256 key
    aesKey, err := GenerateRandomBytes(32)
    if err != nil {
        return nil, fmt.Errorf("generating AES key: %w", err)
    }
    defer func() {
        for i := range aesKey {
            aesKey[i] = 0 // Wipe key from memory
        }
    }()

    // Encrypt the AES key with RSA-OAEP
    encryptedKey, err := RSAEncryptOAEP(pubKey, aesKey, []byte("hybrid-encryption"))
    if err != nil {
        return nil, fmt.Errorf("encrypting AES key: %w", err)
    }

    // Create AES-GCM cipher
    aesCipher, err := NewAESGCMKey(aesKey)
    if err != nil {
        return nil, err
    }

    // Encrypt the actual data
    ciphertext, err := aesCipher.Encrypt(plaintext, nil)
    if err != nil {
        return nil, fmt.Errorf("encrypting data: %w", err)
    }

    // Concatenate: key_len(4) || encrypted_key || ciphertext
    result := make([]byte, 4+len(encryptedKey)+len(ciphertext))
    result[0] = byte(len(encryptedKey) >> 24)
    result[1] = byte(len(encryptedKey) >> 16)
    result[2] = byte(len(encryptedKey) >> 8)
    result[3] = byte(len(encryptedKey))
    copy(result[4:], encryptedKey)
    copy(result[4+len(encryptedKey):], ciphertext)

    return result, nil
}

// HybridDecrypt decrypts data encrypted with HybridEncrypt
func HybridDecrypt(privKey *rsa.PrivateKey, data []byte) ([]byte, error) {
    if len(data) < 4 {
        return nil, errors.New("data too short")
    }

    // Parse key length
    keyLen := int(data[0])<<24 | int(data[1])<<16 | int(data[2])<<8 | int(data[3])
    if len(data) < 4+keyLen {
        return nil, errors.New("truncated encrypted key")
    }

    encryptedKey := data[4 : 4+keyLen]
    ciphertext := data[4+keyLen:]

    // Decrypt the AES key
    aesKey, err := RSADecryptOAEP(privKey, encryptedKey, []byte("hybrid-encryption"))
    if err != nil {
        return nil, fmt.Errorf("decrypting AES key: %w", err)
    }
    defer func() {
        for i := range aesKey {
            aesKey[i] = 0
        }
    }()

    // Decrypt the data
    aesCipher, err := NewAESGCMKey(aesKey)
    if err != nil {
        return nil, err
    }

    return aesCipher.Decrypt(ciphertext, nil)
}
```

## RSA-PSS Digital Signatures

PKCS#1 v1.5 signatures have known vulnerabilities; prefer PSS (Probabilistic Signature Scheme):

```go
package crypto

import (
    "crypto"
    "crypto/rand"
    "crypto/rsa"
    "crypto/sha256"
    "fmt"
)

// SignRSAPSS creates an RSA-PSS signature over data
func SignRSAPSS(privKey *rsa.PrivateKey, data []byte) ([]byte, error) {
    hash := sha256.Sum256(data)

    opts := &rsa.PSSOptions{
        SaltLength: rsa.PSSSaltLengthEqualsHash,
        Hash:       crypto.SHA256,
    }

    sig, err := rsa.SignPSS(rand.Reader, privKey, crypto.SHA256, hash[:], opts)
    if err != nil {
        return nil, fmt.Errorf("RSA-PSS signing: %w", err)
    }
    return sig, nil
}

// VerifyRSAPSS verifies an RSA-PSS signature
func VerifyRSAPSS(pubKey *rsa.PublicKey, data, signature []byte) error {
    hash := sha256.Sum256(data)

    opts := &rsa.PSSOptions{
        SaltLength: rsa.PSSSaltLengthEqualsHash,
        Hash:       crypto.SHA256,
    }

    if err := rsa.VerifyPSS(pubKey, crypto.SHA256, hash[:], signature, opts); err != nil {
        return fmt.Errorf("RSA-PSS verification failed: %w", err)
    }
    return nil
}
```

## ECDH: Elliptic Curve Diffie-Hellman Key Exchange

ECDH allows two parties to establish a shared secret over an insecure channel without transmitting the secret itself:

```go
package crypto

import (
    "crypto/ecdh"
    "crypto/rand"
    "crypto/sha256"
    "encoding/hex"
    "fmt"

    "golang.org/x/crypto/hkdf"
    "io"
)

// ECDHKeyPair wraps an ECDH key pair on P-256
type ECDHKeyPair struct {
    privateKey *ecdh.PrivateKey
}

// GenerateECDHKeyPair generates a new P-256 ECDH key pair
func GenerateECDHKeyPair() (*ECDHKeyPair, error) {
    // P-256 (NIST P-256 / secp256r1) is widely supported and NIST-approved
    // X25519 is faster and has better security properties but less hardware support
    curve := ecdh.P256()

    priv, err := curve.GenerateKey(rand.Reader)
    if err != nil {
        return nil, fmt.Errorf("generating ECDH key: %w", err)
    }

    return &ECDHKeyPair{privateKey: priv}, nil
}

// GenerateX25519KeyPair generates a Curve25519 ECDH key pair (preferred for new systems)
func GenerateX25519KeyPair() (*ECDHKeyPair, error) {
    priv, err := ecdh.X25519().GenerateKey(rand.Reader)
    if err != nil {
        return nil, fmt.Errorf("generating X25519 key: %w", err)
    }
    return &ECDHKeyPair{privateKey: priv}, nil
}

// PublicKeyBytes returns the raw public key bytes for transmission
func (kp *ECDHKeyPair) PublicKeyBytes() []byte {
    return kp.privateKey.PublicKey().Bytes()
}

// DeriveSharedSecret computes the ECDH shared secret with a remote public key
// and derives an AES-256 key using HKDF
func (kp *ECDHKeyPair) DeriveSharedSecret(remotePubKeyBytes []byte, info string) ([]byte, error) {
    curve := kp.privateKey.Curve()

    remotePublicKey, err := curve.NewPublicKey(remotePubKeyBytes)
    if err != nil {
        return nil, fmt.Errorf("parsing remote public key: %w", err)
    }

    // Compute raw shared secret (ECDH output)
    sharedSecret, err := kp.privateKey.ECDH(remotePublicKey)
    if err != nil {
        return nil, fmt.Errorf("ECDH computation: %w", err)
    }

    // CRITICAL: Never use the raw ECDH output directly as a key.
    // Run it through HKDF to derive a proper key.
    hkdfReader := hkdf.New(sha256.New, sharedSecret, nil, []byte(info))
    derivedKey := make([]byte, 32) // AES-256
    if _, err := io.ReadFull(hkdfReader, derivedKey); err != nil {
        return nil, fmt.Errorf("key derivation: %w", err)
    }

    return derivedKey, nil
}

// Example: Complete ECDH key exchange protocol
func ExampleECDHExchange() error {
    // --- Alice's side ---
    aliceKP, err := GenerateX25519KeyPair()
    if err != nil {
        return fmt.Errorf("alice keygen: %w", err)
    }
    alicePub := aliceKP.PublicKeyBytes()

    // --- Bob's side ---
    bobKP, err := GenerateX25519KeyPair()
    if err != nil {
        return fmt.Errorf("bob keygen: %w", err)
    }
    bobPub := bobKP.PublicKeyBytes()

    // Both parties exchange public keys over an insecure channel
    // Then independently compute the same shared secret:

    aliceShared, err := aliceKP.DeriveSharedSecret(bobPub, "session-key-v1")
    if err != nil {
        return fmt.Errorf("alice key derivation: %w", err)
    }

    bobShared, err := bobKP.DeriveSharedSecret(alicePub, "session-key-v1")
    if err != nil {
        return fmt.Errorf("bob key derivation: %w", err)
    }

    // aliceShared == bobShared (they derived the same session key)
    if !ConstantTimeEqual(aliceShared, bobShared) {
        return fmt.Errorf("shared secrets don't match!")
    }

    fmt.Printf("Shared session key: %s\n", hex.EncodeToString(aliceShared[:8])+"...")
    return nil
}
```

## ECDSA: Elliptic Curve Digital Signatures

ECDSA provides digital signatures with much smaller keys than RSA for equivalent security:

```go
package crypto

import (
    "crypto"
    "crypto/ecdsa"
    "crypto/elliptic"
    "crypto/rand"
    "crypto/sha256"
    "crypto/x509"
    "encoding/asn1"
    "encoding/pem"
    "errors"
    "fmt"
    "math/big"
)

// ECDSAKeyPair wraps an ECDSA key pair on P-256
type ECDSAKeyPair struct {
    privateKey *ecdsa.PrivateKey
}

// GenerateECDSAKeyPair generates a new P-256 ECDSA key pair
func GenerateECDSAKeyPair() (*ECDSAKeyPair, error) {
    priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
    if err != nil {
        return nil, fmt.Errorf("generating ECDSA key: %w", err)
    }
    return &ECDSAKeyPair{privateKey: priv}, nil
}

// Sign creates an ECDSA signature over data
func (kp *ECDSAKeyPair) Sign(data []byte) ([]byte, error) {
    hash := sha256.Sum256(data)

    // crypto/ecdsa.Sign returns (r, s) - encode as DER for standard format
    r, s, err := ecdsa.Sign(rand.Reader, kp.privateKey, hash[:])
    if err != nil {
        return nil, fmt.Errorf("ECDSA signing: %w", err)
    }

    // Encode as DER (standard format used by TLS, JWT, etc.)
    sig, err := asn1.Marshal(struct{ R, S *big.Int }{r, s})
    if err != nil {
        return nil, fmt.Errorf("encoding signature: %w", err)
    }

    return sig, nil
}

// Verify checks an ECDSA signature
func (kp *ECDSAKeyPair) Verify(data, signature []byte) error {
    return VerifyECDSA(&kp.privateKey.PublicKey, data, signature)
}

// VerifyECDSA verifies an ECDSA signature with a public key
func VerifyECDSA(pubKey *ecdsa.PublicKey, data, signature []byte) error {
    hash := sha256.Sum256(data)

    var sig struct{ R, S *big.Int }
    if _, err := asn1.Unmarshal(signature, &sig); err != nil {
        return fmt.Errorf("parsing signature: %w", err)
    }

    if !ecdsa.Verify(pubKey, hash[:], sig.R, sig.S) {
        return errors.New("signature verification failed")
    }
    return nil
}

// MarshalPublicKey serializes an ECDSA public key to PEM
func (kp *ECDSAKeyPair) MarshalPublicKey() ([]byte, error) {
    pubBytes, err := x509.MarshalPKIXPublicKey(&kp.privateKey.PublicKey)
    if err != nil {
        return nil, err
    }
    return pem.EncodeToMemory(&pem.Block{
        Type:  "PUBLIC KEY",
        Bytes: pubBytes,
    }), nil
}

// MarshalPrivateKey serializes an ECDSA private key to PEM
func (kp *ECDSAKeyPair) MarshalPrivateKey() ([]byte, error) {
    privBytes, err := x509.MarshalECPrivateKey(kp.privateKey)
    if err != nil {
        return nil, err
    }
    return pem.EncodeToMemory(&pem.Block{
        Type:  "EC PRIVATE KEY",
        Bytes: privBytes,
    }), nil
}

// ParseECDSAPrivateKey parses a PEM-encoded ECDSA private key
func ParseECDSAPrivateKey(pemData []byte) (*ECDSAKeyPair, error) {
    block, _ := pem.Decode(pemData)
    if block == nil {
        return nil, errors.New("failed to decode PEM")
    }

    priv, err := x509.ParseECPrivateKey(block.Bytes)
    if err != nil {
        return nil, fmt.Errorf("parsing ECDSA private key: %w", err)
    }
    return &ECDSAKeyPair{privateKey: priv}, nil
}
```

### Ed25519: Modern Signing Algorithm

For new code, Ed25519 is preferred over ECDSA-P256 due to simpler implementation and better performance:

```go
package crypto

import (
    "crypto/ed25519"
    "crypto/rand"
    "errors"
    "fmt"
)

// Ed25519KeyPair wraps an Ed25519 signing key pair
type Ed25519KeyPair struct {
    privateKey ed25519.PrivateKey
    publicKey  ed25519.PublicKey
}

// GenerateEd25519KeyPair generates a new Ed25519 key pair
func GenerateEd25519KeyPair() (*Ed25519KeyPair, error) {
    pub, priv, err := ed25519.GenerateKey(rand.Reader)
    if err != nil {
        return nil, fmt.Errorf("generating Ed25519 key: %w", err)
    }
    return &Ed25519KeyPair{privateKey: priv, publicKey: pub}, nil
}

// Sign creates an Ed25519 signature (no hashing needed - Ed25519 does it internally)
func (kp *Ed25519KeyPair) Sign(message []byte) []byte {
    return ed25519.Sign(kp.privateKey, message)
}

// Verify checks an Ed25519 signature
func (kp *Ed25519KeyPair) Verify(message, signature []byte) error {
    if !ed25519.Verify(kp.publicKey, message, signature) {
        return errors.New("Ed25519 signature verification failed")
    }
    return nil
}

// VerifyWithPublicKey verifies using a raw public key bytes
func VerifyEd25519(publicKey, message, signature []byte) error {
    if len(publicKey) != ed25519.PublicKeySize {
        return fmt.Errorf("invalid Ed25519 public key size: %d", len(publicKey))
    }
    if !ed25519.Verify(ed25519.PublicKey(publicKey), message, signature) {
        return errors.New("Ed25519 signature verification failed")
    }
    return nil
}

// PublicKeyBytes returns the 32-byte public key
func (kp *Ed25519KeyPair) PublicKeyBytes() []byte {
    return []byte(kp.publicKey)
}

// PrivateKeyBytes returns the 64-byte private key (seed || public key)
func (kp *Ed25519KeyPair) PrivateKeyBytes() []byte {
    return []byte(kp.privateKey)
}

// Seed returns the 32-byte seed (private key input)
func (kp *Ed25519KeyPair) Seed() []byte {
    return kp.privateKey.Seed()
}
```

## JWT Signing with ECDSA

A common use case for ECDSA is signing JWT tokens:

```go
package auth

import (
    "crypto"
    "crypto/ecdsa"
    "crypto/rand"
    "crypto/sha256"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "math/big"
    "encoding/asn1"
    "strings"
    "time"
)

type JWTHeader struct {
    Algorithm string `json:"alg"`
    Type      string `json:"typ"`
}

type JWTClaims struct {
    Subject   string `json:"sub"`
    IssuedAt  int64  `json:"iat"`
    ExpiresAt int64  `json:"exp"`
    Issuer    string `json:"iss"`
    // Custom claims
    Roles     []string `json:"roles,omitempty"`
}

// SignJWT creates a signed JWT with ES256 (ECDSA P-256 + SHA-256)
func SignJWT(claims JWTClaims, privKey *ecdsa.PrivateKey) (string, error) {
    // Header
    header := JWTHeader{Algorithm: "ES256", Type: "JWT"}
    headerJSON, err := json.Marshal(header)
    if err != nil {
        return "", err
    }

    // Claims
    claimsJSON, err := json.Marshal(claims)
    if err != nil {
        return "", err
    }

    // Encode header and claims
    headerB64 := base64.RawURLEncoding.EncodeToString(headerJSON)
    claimsB64 := base64.RawURLEncoding.EncodeToString(claimsJSON)
    signingInput := headerB64 + "." + claimsB64

    // Sign
    hash := sha256.Sum256([]byte(signingInput))
    r, s, err := ecdsa.Sign(rand.Reader, privKey, hash[:])
    if err != nil {
        return "", fmt.Errorf("signing JWT: %w", err)
    }

    // ES256 signature format: r || s, each zero-padded to 32 bytes
    keySize := (privKey.Curve.Params().BitSize + 7) / 8
    sigBytes := make([]byte, 2*keySize)
    r.FillBytes(sigBytes[:keySize])
    s.FillBytes(sigBytes[keySize:])

    sigB64 := base64.RawURLEncoding.EncodeToString(sigBytes)
    return signingInput + "." + sigB64, nil
}

// VerifyJWT verifies and parses a JWT signed with ES256
func VerifyJWT(token string, pubKey *ecdsa.PublicKey) (*JWTClaims, error) {
    parts := strings.Split(token, ".")
    if len(parts) != 3 {
        return nil, fmt.Errorf("invalid JWT format")
    }

    signingInput := parts[0] + "." + parts[1]

    // Decode and verify signature
    sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
    if err != nil {
        return nil, fmt.Errorf("decoding signature: %w", err)
    }

    keySize := (pubKey.Curve.Params().BitSize + 7) / 8
    if len(sigBytes) != 2*keySize {
        return nil, fmt.Errorf("invalid signature length")
    }

    r := new(big.Int).SetBytes(sigBytes[:keySize])
    s := new(big.Int).SetBytes(sigBytes[keySize:])

    hash := sha256.Sum256([]byte(signingInput))
    if !ecdsa.Verify(pubKey, hash[:], r, s) {
        return nil, fmt.Errorf("JWT signature verification failed")
    }

    // Decode claims
    claimsJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
    if err != nil {
        return nil, fmt.Errorf("decoding claims: %w", err)
    }

    var claims JWTClaims
    if err := json.Unmarshal(claimsJSON, &claims); err != nil {
        return nil, fmt.Errorf("parsing claims: %w", err)
    }

    // Validate expiration
    if claims.ExpiresAt > 0 && time.Now().Unix() > claims.ExpiresAt {
        return nil, fmt.Errorf("JWT expired")
    }

    return &claims, nil
}
```

## Key Storage Best Practices

```go
package crypto

import (
    "crypto/rand"
    "fmt"
    "os"

    "golang.org/x/crypto/argon2"
)

// EncryptedKeyFile stores an encrypted private key
type EncryptedKeyFile struct {
    Salt       []byte `json:"salt"`
    Nonce      []byte `json:"nonce"`
    Ciphertext []byte `json:"ciphertext"`
    // Argon2 parameters for future compatibility
    TimeCost   uint32 `json:"time_cost"`
    MemoryCost uint32 `json:"memory_cost"`
    Threads    uint8  `json:"threads"`
}

// EncryptPrivateKey encrypts a private key with a passphrase
func EncryptPrivateKey(privateKeyPEM, passphrase []byte) (*EncryptedKeyFile, error) {
    salt, err := GenerateRandomBytes(32)
    if err != nil {
        return nil, err
    }

    // Derive encryption key from passphrase
    timeCost := uint32(3)
    memoryCost := uint32(64 * 1024)
    threads := uint8(4)

    encKey := argon2.IDKey(passphrase, salt, timeCost, memoryCost, threads, 32)

    // Encrypt with AES-GCM
    cipher, err := NewAESGCMKey(encKey)
    if err != nil {
        return nil, err
    }

    ciphertext, err := cipher.Encrypt(privateKeyPEM, nil)
    if err != nil {
        return nil, err
    }

    return &EncryptedKeyFile{
        Salt:       salt,
        Ciphertext: ciphertext,
        TimeCost:   timeCost,
        MemoryCost: memoryCost,
        Threads:    threads,
    }, nil
}

// DecryptPrivateKey decrypts a private key using a passphrase
func DecryptPrivateKey(ekf *EncryptedKeyFile, passphrase []byte) ([]byte, error) {
    encKey := argon2.IDKey(passphrase, ekf.Salt, ekf.TimeCost, ekf.MemoryCost, ekf.Threads, 32)

    cipher, err := NewAESGCMKey(encKey)
    if err != nil {
        return nil, err
    }

    return cipher.Decrypt(ekf.Ciphertext, nil)
}

// KeyFromEnv loads a key from environment variable or file
// Never hardcode keys in source code
func KeyFromEnv(envVar, filePath string) ([]byte, error) {
    // Try environment variable first
    if val := os.Getenv(envVar); val != "" {
        // Assume base64-encoded
        key, err := base64.StdEncoding.DecodeString(val)
        if err != nil {
            return nil, fmt.Errorf("decoding %s from env: %w", envVar, err)
        }
        return key, nil
    }

    // Fall back to file
    if filePath != "" {
        key, err := os.ReadFile(filePath)
        if err != nil {
            return nil, fmt.Errorf("reading key file %s: %w", filePath, err)
        }
        return bytes.TrimSpace(key), nil
    }

    return nil, fmt.Errorf("no key source configured (env: %s, file: %s)", envVar, filePath)
}
```

## Common Cryptographic Pitfalls

```go
// WRONG: Using ECB mode (patterns visible in ciphertext)
// block, _ := aes.NewCipher(key)
// block.Encrypt(dst, src)  // ECB - DO NOT USE

// WRONG: Reusing nonces
// nonce := []byte("fixed-nonce-bad!")  // DO NOT USE - nonce reuse breaks GCM security

// WRONG: Using MD5 or SHA-1 for security-sensitive hashing
// hash := md5.Sum(data)    // DO NOT USE for security
// hash := sha1.Sum(data)   // DO NOT USE for security

// WRONG: RSA PKCS#1 v1.5 encryption (vulnerable to Bleichenbacher)
// ciphertext, _ := rsa.EncryptPKCS1v15(rand.Reader, pubKey, data)  // AVOID

// WRONG: Comparing MACs with ==
// if string(expectedMAC) == string(receivedMAC) {}  // Timing attack vulnerability

// RIGHT: Use hmac.Equal for MAC comparison
import "crypto/hmac"
if !hmac.Equal(expectedMAC, receivedMAC) {
    return errors.New("MAC verification failed")
}

// WRONG: Small RSA keys
// rsa.GenerateKey(rand.Reader, 512)   // Way too small

// RIGHT: Minimum 2048-bit RSA, prefer 4096 for long-lived keys
// rsa.GenerateKey(rand.Reader, 4096)

// WRONG: Using time-based seeds with math/rand
// rand.Seed(time.Now().UnixNano())   // Predictable!

// RIGHT: Use crypto/rand always
// io.ReadFull(crypto.rand.Reader, buf)
```

## Summary

Go's cryptographic standard library provides secure primitives when used correctly. The key patterns from this post are:

- **AES-256-GCM**: Symmetric encryption with authentication; always generate a unique random nonce per encryption; use `XChaCha20-Poly1305` when random nonces might repeat
- **HKDF**: Derive purpose-specific subkeys from a master key rather than using the master key directly
- **RSA-OAEP**: For key encapsulation with SHA-256; never use PKCS#1 v1.5 encryption in new code; use hybrid encryption for data larger than the OAEP limit
- **ECDH + HKDF**: Key exchange for establishing session keys; never use raw ECDH output as a key
- **Ed25519**: Preferred signing algorithm for new systems; simpler and faster than ECDSA with equivalent security
- **ECDSA-P256**: Use when Ed25519 compatibility is required (TLS, existing systems)
- **`crypto/rand`**: Always use it; never use `math/rand` for cryptographic purposes
- **Key storage**: Encrypt private keys at rest with Argon2id key derivation; load keys from environment variables or files, never hardcode them

The most important principle: never roll your own cryptographic algorithms. Use the standard library primitives with the patterns shown here.
