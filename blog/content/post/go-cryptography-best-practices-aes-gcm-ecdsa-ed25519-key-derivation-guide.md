---
title: "Go Cryptography Best Practices: AES-GCM, ECDSA, Ed25519, Constant-Time Comparisons, and Key Derivation"
date: 2031-11-22T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Cryptography", "Security", "AES-GCM", "Ed25519", "ECDSA", "HKDF", "Enterprise Security"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production security guide to Go cryptography: implementing AES-GCM authenticated encryption, ECDSA and Ed25519 digital signatures, constant-time comparison to prevent timing attacks, HKDF key derivation, and building cryptographic systems that are correct by construction."
more_link: "yes"
url: "/go-cryptography-best-practices-aes-gcm-ecdsa-ed25519-key-derivation-guide/"
---

Cryptography in application code is a minefield. The standard library provides the correct primitives, but using them correctly requires understanding why certain patterns exist and what attacks they prevent. A subtle mistake — reusing a nonce with AES-GCM, using `==` to compare MACs, or failing to validate a public key — can completely undermine the security guarantees you thought you had.

This guide covers the production patterns for Go cryptography: authenticated encryption with AES-GCM, digital signatures with ECDSA and Ed25519, constant-time comparison to prevent timing side-channels, HKDF for key derivation, and the architectural decisions that make cryptographic systems auditable and correct.

<!--more-->

# Go Cryptography Best Practices

## The Fundamental Rule

**Never invent your own cryptographic constructions.** Use high-level interfaces when they exist (TLS, nacl/box, crypto/tls). Drop to low-level primitives only when you have a specific need that higher-level interfaces cannot fulfill, and when you do, use the standard library's implementations — never third-party alternatives for core primitives.

## Symmetric Encryption: AES-GCM

AES-GCM (Galois/Counter Mode) is the correct choice for most symmetric encryption needs. It provides:
- Confidentiality (encryption)
- Integrity (authentication tag)
- Additional data authentication (AAD — you can authenticate context without encrypting it)

### Why GCM, Not CBC

AES-CBC without a MAC (Message Authentication Code) is unauthenticated — an attacker can modify ciphertext and you will not know. The "encrypt-then-MAC" pattern is correct but easy to get wrong. AES-GCM is an authenticated encryption scheme (AEAD) that handles both in one operation.

### Complete AES-GCM Implementation

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

const (
    // NonceSize is the required nonce length for AES-GCM (96 bits)
    NonceSize = 12
    // TagSize is the GCM authentication tag size (128 bits)
    TagSize = 16
    // KeySize256 is the recommended AES key size
    KeySize256 = 32
    // KeySize128 is the minimum acceptable AES key size
    KeySize128 = 16
)

// Encryptor holds the cipher for repeated encryption operations
type Encryptor struct {
    aead cipher.AEAD
}

// NewEncryptor creates an AES-GCM encryptor with the provided key.
// The key must be exactly 16, 24, or 32 bytes (AES-128, AES-192, AES-256).
func NewEncryptor(key []byte) (*Encryptor, error) {
    if len(key) != KeySize128 && len(key) != 24 && len(key) != KeySize256 {
        return nil, fmt.Errorf("invalid key size %d: must be 16, 24, or 32 bytes", len(key))
    }

    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, fmt.Errorf("creating AES cipher: %w", err)
    }

    aead, err := cipher.NewGCM(block)
    if err != nil {
        return nil, fmt.Errorf("creating GCM: %w", err)
    }

    return &Encryptor{aead: aead}, nil
}

// Encrypt encrypts plaintext with authenticated additional data.
// The returned ciphertext is: nonce || ciphertext || tag
// additionalData is authenticated but NOT encrypted (can be nil).
func (e *Encryptor) Encrypt(plaintext, additionalData []byte) ([]byte, error) {
    // Generate a random nonce for each encryption operation
    // CRITICAL: Never reuse a nonce with the same key.
    // With AES-GCM, nonce reuse allows an attacker to recover the plaintext
    // and forge authentication tags.
    nonce := make([]byte, NonceSize)
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, fmt.Errorf("generating nonce: %w", err)
    }

    // Seal appends the encrypted ciphertext and authentication tag to nonce
    // Output format: nonce (12 bytes) + ciphertext + tag (16 bytes)
    ciphertext := e.aead.Seal(nonce, nonce, plaintext, additionalData)
    return ciphertext, nil
}

// Decrypt decrypts and authenticates ciphertext.
// Returns an error if authentication fails — do not use partial output on error.
func (e *Encryptor) Decrypt(ciphertext, additionalData []byte) ([]byte, error) {
    if len(ciphertext) < NonceSize+TagSize {
        return nil, errors.New("ciphertext too short")
    }

    // Extract nonce from the front of the ciphertext
    nonce := ciphertext[:NonceSize]
    ciphertext = ciphertext[NonceSize:]

    // Open decrypts and verifies the authentication tag
    // Returns an error if the tag is invalid (tampering detected)
    plaintext, err := e.aead.Open(nil, nonce, ciphertext, additionalData)
    if err != nil {
        // Do NOT return partial plaintext on authentication failure
        // Do NOT expose internal error details to callers (timing oracle)
        return nil, errors.New("decryption failed: authentication error")
    }

    return plaintext, nil
}
```

### Key Generation

```go
// GenerateKey generates a cryptographically random AES key.
func GenerateKey(bits int) ([]byte, error) {
    if bits != 128 && bits != 192 && bits != 256 {
        return nil, fmt.Errorf("invalid key size: must be 128, 192, or 256")
    }
    key := make([]byte, bits/8)
    if _, err := io.ReadFull(rand.Reader, key); err != nil {
        return nil, fmt.Errorf("generating random key: %w", err)
    }
    return key, nil
}
```

### Using Additional Data for Context Binding

Additional data (AAD) is a powerful feature: it lets you bind encrypted data to a specific context. If the AAD does not match during decryption, authentication fails — even if the ciphertext itself is valid.

```go
// Example: encrypt a user token bound to their user ID and session ID
// This prevents an attacker from copying a valid encrypted token to a different user's context

type TokenService struct {
    enc *Encryptor
}

type TokenClaims struct {
    UserID    string
    SessionID string
    IssuedAt  time.Time
    ExpiresAt time.Time
}

func (ts *TokenService) IssueToken(claims TokenClaims) ([]byte, error) {
    plaintext, err := json.Marshal(claims)
    if err != nil {
        return nil, err
    }

    // AAD: binds token to specific user and session
    // Even if attacker copies encrypted bytes, they cannot use it
    // in a different user's context
    aad := []byte(fmt.Sprintf("user:%s:session:%s", claims.UserID, claims.SessionID))

    return ts.enc.Encrypt(plaintext, aad)
}

func (ts *TokenService) ValidateToken(
    userID, sessionID string,
    token []byte,
) (*TokenClaims, error) {
    aad := []byte(fmt.Sprintf("user:%s:session:%s", userID, sessionID))

    plaintext, err := ts.enc.Decrypt(token, aad)
    if err != nil {
        return nil, fmt.Errorf("invalid token")
    }

    var claims TokenClaims
    if err := json.Unmarshal(plaintext, &claims); err != nil {
        return nil, fmt.Errorf("invalid token format")
    }

    if time.Now().After(claims.ExpiresAt) {
        return nil, fmt.Errorf("token expired")
    }

    return &claims, nil
}
```

## Digital Signatures: Ed25519

Ed25519 is the recommended signature algorithm for new systems:
- Fast (Edwards curve over Curve25519)
- No random number generation required for signing (deterministic)
- Small key and signature sizes (32-byte keys, 64-byte signatures)
- No parameter choices to get wrong (unlike ECDSA)

```go
package signing

import (
    "crypto/ed25519"
    "crypto/rand"
    "crypto/x509"
    "encoding/pem"
    "errors"
    "fmt"
    "os"
)

// GenerateEd25519KeyPair generates a new Ed25519 key pair.
func GenerateEd25519KeyPair() (ed25519.PublicKey, ed25519.PrivateKey, error) {
    pub, priv, err := ed25519.GenerateKey(rand.Reader)
    if err != nil {
        return nil, nil, fmt.Errorf("generating Ed25519 key pair: %w", err)
    }
    return pub, priv, nil
}

// Sign creates an Ed25519 signature over the message.
// Unlike ECDSA, Ed25519 signing is deterministic — it does not require
// random number generation, eliminating the risk of nonce reuse.
func Sign(priv ed25519.PrivateKey, message []byte) ([]byte, error) {
    if len(priv) != ed25519.PrivateKeySize {
        return nil, fmt.Errorf("invalid private key size: %d", len(priv))
    }
    // ed25519.Sign never returns an error in the standard library,
    // but we handle it defensively
    sig := ed25519.Sign(priv, message)
    return sig, nil
}

// Verify checks an Ed25519 signature.
// Returns nil if valid, error if invalid or if inputs are malformed.
func Verify(pub ed25519.PublicKey, message, sig []byte) error {
    if len(pub) != ed25519.PublicKeySize {
        return fmt.Errorf("invalid public key size: %d", len(pub))
    }
    if len(sig) != ed25519.SignatureSize {
        return fmt.Errorf("invalid signature size: %d", len(sig))
    }
    if !ed25519.Verify(pub, message, sig) {
        return errors.New("signature verification failed")
    }
    return nil
}

// Serialization: PEM encoding for key storage

// PrivateKeyToPEM serializes an Ed25519 private key to PEM format.
func PrivateKeyToPEM(priv ed25519.PrivateKey) ([]byte, error) {
    der, err := x509.MarshalPKCS8PrivateKey(priv)
    if err != nil {
        return nil, fmt.Errorf("marshaling private key: %w", err)
    }
    return pem.EncodeToMemory(&pem.Block{
        Type:  "PRIVATE KEY",
        Bytes: der,
    }), nil
}

// PublicKeyToPEM serializes an Ed25519 public key to PEM format.
func PublicKeyToPEM(pub ed25519.PublicKey) ([]byte, error) {
    der, err := x509.MarshalPKIXPublicKey(pub)
    if err != nil {
        return nil, fmt.Errorf("marshaling public key: %w", err)
    }
    return pem.EncodeToMemory(&pem.Block{
        Type:  "PUBLIC KEY",
        Bytes: der,
    }), nil
}

// PrivateKeyFromPEM deserializes a private key from PEM format.
func PrivateKeyFromPEM(pemBytes []byte) (ed25519.PrivateKey, error) {
    block, _ := pem.Decode(pemBytes)
    if block == nil {
        return nil, errors.New("failed to decode PEM block")
    }
    key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
    if err != nil {
        return nil, fmt.Errorf("parsing private key: %w", err)
    }
    ed25519Key, ok := key.(ed25519.PrivateKey)
    if !ok {
        return nil, fmt.Errorf("key is not Ed25519, got %T", key)
    }
    return ed25519Key, nil
}
```

## ECDSA Signatures

Use ECDSA when you need compatibility with systems that do not support Ed25519 (older TLS stacks, HSMs, smart cards). P-256 (prime256v1) is the recommended curve.

```go
package signing

import (
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

// ECDSASignature represents the ASN.1 DER-encoded ECDSA signature components.
type ECDSASignature struct {
    R, S *big.Int
}

// GenerateECDSAKeyPair generates a P-256 ECDSA key pair.
func GenerateECDSAKeyPair() (*ecdsa.PrivateKey, error) {
    // P-256 (NIST P-256, prime256v1, secp256r1) is the recommended curve.
    // P-384 is acceptable for higher security margins.
    // Do NOT use P-224 (too small) or Koblitz curves (K-256) unless required.
    priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
    if err != nil {
        return nil, fmt.Errorf("generating ECDSA key pair: %w", err)
    }
    return priv, nil
}

// ECDSASign creates an ECDSA signature over the message.
// CRITICAL: ECDSA signing requires random number generation.
// If the random number generator produces the same nonce twice with the same key,
// the private key can be recovered. Use Go's crypto/rand (which uses OS CSPRNG).
// This is why Ed25519 is preferred: it is deterministic.
func ECDSASign(priv *ecdsa.PrivateKey, message []byte) ([]byte, error) {
    // Hash the message: ECDSA signs a hash, not raw data
    hash := sha256.Sum256(message)

    // rand.Reader is the OS CSPRNG — safe to use
    r, s, err := ecdsa.Sign(rand.Reader, priv, hash[:])
    if err != nil {
        return nil, fmt.Errorf("signing: %w", err)
    }

    // Encode as DER (standard format for interoperability)
    sig, err := asn1.Marshal(ECDSASignature{R: r, S: s})
    if err != nil {
        return nil, fmt.Errorf("encoding signature: %w", err)
    }
    return sig, nil
}

// ECDSAVerify verifies an ECDSA signature.
func ECDSAVerify(pub *ecdsa.PublicKey, message, sigDER []byte) error {
    // Validate the public key is on the expected curve
    if !pub.Curve.IsOnCurve(pub.X, pub.Y) {
        return errors.New("invalid public key: point not on curve")
    }

    // Decode DER signature
    var sig ECDSASignature
    if _, err := asn1.Unmarshal(sigDER, &sig); err != nil {
        return fmt.Errorf("decoding signature: %w", err)
    }

    // Validate signature components are positive
    if sig.R.Sign() <= 0 || sig.S.Sign() <= 0 {
        return errors.New("invalid signature: r and s must be positive")
    }

    hash := sha256.Sum256(message)
    if !ecdsa.Verify(pub, hash[:], sig.R, sig.S) {
        return errors.New("signature verification failed")
    }
    return nil
}
```

## Constant-Time Comparisons

Timing attacks exploit the fact that string comparison (`==`, `bytes.Equal`) short-circuits on the first unequal byte. An attacker who can measure response time can deduce how many bytes of their guess are correct, allowing them to reconstruct a secret one byte at a time.

### The Attack

```go
// VULNERABLE: timing attack
func checkTokenVulnerable(expected, provided []byte) bool {
    return bytes.Equal(expected, provided)
    // If expected = "abc..." and provided = "xyz...",
    // comparison fails on first byte (fast)
    // If expected = "abc..." and provided = "abd...",
    // comparison fails on third byte (slightly slower)
    // Attacker can measure these differences
}

// CORRECT: constant-time comparison
import "crypto/subtle"

func checkTokenSecure(expected, provided []byte) bool {
    // subtle.ConstantTimeCompare always examines every byte
    // Returns 1 if equal, 0 if not — runs in constant time regardless of content
    return subtle.ConstantTimeCompare(expected, provided) == 1
}
```

### Complete Constant-Time Implementation

```go
package secure

import (
    "crypto/hmac"
    "crypto/sha256"
    "crypto/subtle"
)

// CompareMAC compares two HMACs in constant time.
// Use this when comparing authentication tags, HMACs, or other secrets.
func CompareMAC(a, b []byte) bool {
    return subtle.ConstantTimeCompare(a, b) == 1
}

// CompareStrings compares two strings in constant time.
// Always use this when comparing secrets (passwords, tokens, keys).
func CompareStrings(a, b string) bool {
    return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// HMAC computes HMAC-SHA256 of the message with the key.
func HMAC(key, message []byte) []byte {
    mac := hmac.New(sha256.New, key)
    mac.Write(message)
    return mac.Sum(nil)
}

// VerifyHMAC verifies a message authentication code in constant time.
// This is the correct pattern for HMAC verification.
func VerifyHMAC(key, message, expectedMAC []byte) bool {
    // Compute the HMAC ourselves
    actualMAC := HMAC(key, message)
    // Use hmac.Equal which is constant-time
    // (equivalent to subtle.ConstantTimeCompare but semantically clearer)
    return hmac.Equal(actualMAC, expectedMAC)
}

// SecureTokenEqual compares two tokens in constant time,
// handling the case where they have different lengths.
// Different-length tokens are always unequal, but we still run
// constant-time to avoid leaking length information.
func SecureTokenEqual(a, b []byte) bool {
    // subtle.ConstantTimeCompare returns 0 immediately if lengths differ,
    // which leaks length information. To avoid this, compare the HMAC
    // of both values instead.
    //
    // For most use cases, subtle.ConstantTimeCompare is fine
    // since token lengths are not secret (they are fixed-length).
    return subtle.ConstantTimeCompare(a, b) == 1
}
```

### When to Use Constant-Time Comparison

Always use constant-time comparison for:
- API tokens, session tokens
- Password hashes (though `bcrypt.CompareHashAndPassword` handles this)
- HMAC authentication tags
- Any cryptographic secret that an attacker might guess

You do NOT need constant-time comparison for:
- Public data (user IDs, usernames)
- Data that the attacker already knows
- Non-cryptographic comparisons

## Key Derivation with HKDF

Never use a raw password or low-entropy input directly as a cryptographic key. HKDF (HMAC-based Key Derivation Function) derives one or more keys from a master secret with explicit domain separation.

```go
package crypto

import (
    "crypto/sha256"
    "fmt"
    "io"

    "golang.org/x/crypto/hkdf"
)

// DeriveKey derives a cryptographic key from a master secret using HKDF.
// salt: random value (can be public, but should be unique per context)
// info: context string for domain separation (e.g., "encryption-v1", "signing-v1")
// length: desired key length in bytes
func DeriveKey(masterSecret, salt, info []byte, length int) ([]byte, error) {
    if length <= 0 || length > 255*32 {
        return nil, fmt.Errorf("invalid key length: %d", length)
    }

    // HKDF with SHA-256: extract phase uses salt, expand phase uses info
    reader := hkdf.New(sha256.New, masterSecret, salt, info)
    key := make([]byte, length)
    if _, err := io.ReadFull(reader, key); err != nil {
        return nil, fmt.Errorf("deriving key: %w", err)
    }
    return key, nil
}

// DeriveMultipleKeys derives multiple keys from a single master secret.
// Each key is derived with unique info for domain separation.
// This is the correct pattern for deriving encryption + signing keys from one root.
type DerivedKeys struct {
    EncryptionKey []byte
    SigningKey     []byte
    MACKey         []byte
}

func DeriveApplicationKeys(masterSecret, salt []byte) (*DerivedKeys, error) {
    // Each key uses a different info string — they are completely independent
    // even though they come from the same master secret.
    encKey, err := DeriveKey(masterSecret, salt, []byte("app-encryption-key-v1"), 32)
    if err != nil {
        return nil, fmt.Errorf("deriving encryption key: %w", err)
    }

    sigKey, err := DeriveKey(masterSecret, salt, []byte("app-signing-key-v1"), 32)
    if err != nil {
        return nil, fmt.Errorf("deriving signing key: %w", err)
    }

    macKey, err := DeriveKey(masterSecret, salt, []byte("app-mac-key-v1"), 32)
    if err != nil {
        return nil, fmt.Errorf("deriving MAC key: %w", err)
    }

    return &DerivedKeys{
        EncryptionKey: encKey,
        SigningKey:     sigKey,
        MACKey:         macKey,
    }, nil
}
```

### Password Hashing

For password storage, use `bcrypt`, `argon2id`, or `scrypt`. These are intentionally slow:

```go
import "golang.org/x/crypto/bcrypt"

const bcryptCost = 12  // Minimum 12 for new systems; 14+ for high-security

func HashPassword(password string) (string, error) {
    hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
    if err != nil {
        return "", fmt.Errorf("hashing password: %w", err)
    }
    return string(hash), nil
}

// VerifyPassword checks a password against a bcrypt hash.
// bcrypt.CompareHashAndPassword is constant-time.
func VerifyPassword(hash, password string) bool {
    err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
    return err == nil
}
```

For higher-security requirements, use argon2id:

```go
import (
    "crypto/rand"
    "encoding/hex"
    "golang.org/x/crypto/argon2"
)

type Argon2Params struct {
    Time    uint32  // Number of iterations
    Memory  uint32  // Memory in KiB
    Threads uint8   // Parallelism
    KeyLen  uint32  // Output key length
    SaltLen uint32  // Salt length
}

// OWASP recommended minimum parameters for argon2id (2024)
var DefaultArgon2Params = Argon2Params{
    Time:    2,
    Memory:  19 * 1024,  // 19 MiB
    Threads: 1,
    KeyLen:  32,
    SaltLen: 16,
}

func HashPasswordArgon2(password string, p Argon2Params) (string, error) {
    salt := make([]byte, p.SaltLen)
    if _, err := rand.Read(salt); err != nil {
        return "", err
    }

    hash := argon2.IDKey(
        []byte(password),
        salt,
        p.Time,
        p.Memory,
        p.Threads,
        p.KeyLen,
    )

    // Encode: salt$hash (both hex-encoded)
    return fmt.Sprintf("%s$%s", hex.EncodeToString(salt), hex.EncodeToString(hash)), nil
}
```

## Cryptographically Secure Random Numbers

```go
import (
    "crypto/rand"
    "encoding/binary"
    "math/big"
)

// RandomBytes generates n cryptographically random bytes.
func RandomBytes(n int) ([]byte, error) {
    b := make([]byte, n)
    if _, err := rand.Read(b); err != nil {
        return nil, fmt.Errorf("reading random bytes: %w", err)
    }
    return b, nil
}

// RandomUint64 generates a cryptographically random uint64.
func RandomUint64() (uint64, error) {
    b := make([]byte, 8)
    if _, err := rand.Read(b); err != nil {
        return 0, err
    }
    return binary.BigEndian.Uint64(b), nil
}

// RandomInRange generates a random integer in [0, max).
// Use this instead of math/rand for security-sensitive values.
func RandomInRange(max *big.Int) (*big.Int, error) {
    return rand.Int(rand.Reader, max)
}

// GenerateToken generates a URL-safe random token of the specified byte length.
// A 32-byte (256-bit) token has sufficient entropy to be unguessable.
func GenerateToken(byteLen int) (string, error) {
    b, err := RandomBytes(byteLen)
    if err != nil {
        return "", err
    }
    // base64url encoding for URL safety
    return base64.RawURLEncoding.EncodeToString(b), nil
}
```

## Common Mistakes Reference

| Mistake | Consequence | Fix |
|---|---|---|
| Reusing AES-GCM nonce | Key recovery, auth bypass | Use `io.ReadFull(rand.Reader, nonce)` per encryption |
| Unauthenticated AES-CBC | Padding oracle, bit flipping | Use AES-GCM (AEAD) |
| `bytes.Equal` for secrets | Timing attack | `subtle.ConstantTimeCompare` |
| ECB mode | Identical blocks produce identical ciphertext | Never use ECB |
| Non-constant time HMAC compare | Timing attack | `hmac.Equal()` |
| Using `math/rand` for secrets | Predictable values | `crypto/rand` only |
| MD5/SHA1 for new systems | Collision vulnerabilities | SHA-256 or SHA-3 |
| ECDSA without random source | Key recovery if nonce repeats | Ed25519 (deterministic) |
| Raw key from password | Weak key | bcrypt + HKDF |
| Ignoring MAC verification error | Use of unauthenticated data | Always handle the error |

## Summary

Correct cryptography in Go requires using the right algorithm, using it correctly, and avoiding subtle implementation bugs. AES-GCM with random nonces provides authenticated encryption in a single operation. Ed25519 is the safest signature algorithm for new systems due to its deterministic signing and resistance to nonce-reuse attacks. Constant-time comparisons with `crypto/subtle` are mandatory for any comparison involving secret values. HKDF with explicit info strings provides clean domain separation when deriving multiple keys from a single root secret. These patterns, applied consistently, produce a cryptographic system that is correct by construction and auditable by inspection.
