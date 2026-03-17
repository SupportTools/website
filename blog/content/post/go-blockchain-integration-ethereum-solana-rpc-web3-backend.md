---
title: "Go Blockchain Integration: Ethereum, Solana RPC Clients, and Web3 Backend Services"
date: 2030-03-29T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Blockchain", "Ethereum", "Solana", "Web3", "go-ethereum", "Smart Contracts"]
categories: ["Go", "Blockchain", "Backend Development"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to building Go backend services that interact with blockchain networks, covering go-ethereum client integration, Solana JSON-RPC, event subscriptions, transaction building, and secure key management without exposing private keys."
more_link: "yes"
url: "/go-blockchain-integration-ethereum-solana-rpc-web3-backend/"
---

Backend services that interact with blockchain networks face a distinct set of engineering challenges compared to traditional database-backed applications. The immutability of blockchain state means that bugs in transaction logic result in permanent, irrecoverable errors. Network latency and finality times introduce asynchronous patterns that require careful handling. Private key management is a security problem with consequences that no database breach can match.

This guide focuses on building production-quality Go backend services that interact with Ethereum and Solana networks. The emphasis is on patterns that keep key material out of application memory, handle the asynchronous nature of blockchain confirmation correctly, and provide the observability needed to operate these services reliably.

<!--more-->

## go-ethereum: Ethereum Client in Go

The `go-ethereum` package (also called `geth`) provides the standard Go library for interacting with Ethereum-compatible networks. It supports JSON-RPC, WebSocket subscriptions, ABI encoding/decoding, and transaction signing.

### Project Setup

```bash
# Initialize module
go mod init github.com/yourorg/blockchain-service

# Install go-ethereum
go get github.com/ethereum/go-ethereum@v1.15.0

# Install supporting packages
go get github.com/ethereum/go-ethereum/accounts/abi
go get github.com/ethereum/go-ethereum/crypto
go get github.com/ethereum/go-ethereum/ethclient
```

### Connecting to Ethereum Networks

```go
// client/ethereum.go
package client

import (
    "context"
    "fmt"
    "log/slog"
    "math/big"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
    "github.com/ethereum/go-ethereum/rpc"
)

// Config holds Ethereum connection configuration
type Config struct {
    // HTTP endpoint for queries and transactions
    HTTPURL string
    // WebSocket endpoint for event subscriptions (optional)
    WSURL string
    // Maximum time to wait for a single RPC call
    CallTimeout time.Duration
    // Retry configuration
    MaxRetries  int
    RetryDelay  time.Duration
}

// Client wraps go-ethereum clients with production-grade configuration
type Client struct {
    http    *ethclient.Client
    ws      *ethclient.Client   // nil if no WebSocket URL provided
    chainID *big.Int
    log     *slog.Logger
    cfg     Config
}

// NewClient creates a new Ethereum client
func NewClient(ctx context.Context, cfg Config, log *slog.Logger) (*Client, error) {
    // Connect via HTTP
    httpClient, err := ethclient.DialContext(ctx, cfg.HTTPURL)
    if err != nil {
        return nil, fmt.Errorf("dial http rpc %s: %w", cfg.HTTPURL, err)
    }

    // Verify connection by fetching chain ID
    chainCtx, cancel := context.WithTimeout(ctx, cfg.CallTimeout)
    defer cancel()
    chainID, err := httpClient.ChainID(chainCtx)
    if err != nil {
        httpClient.Close()
        return nil, fmt.Errorf("get chain id: %w", err)
    }
    log.Info("connected to ethereum",
        "chain_id", chainID.String(),
        "endpoint", cfg.HTTPURL,
    )

    c := &Client{
        http:    httpClient,
        chainID: chainID,
        log:     log,
        cfg:     cfg,
    }

    // Connect WebSocket if provided (for subscriptions)
    if cfg.WSURL != "" {
        wsClient, err := ethclient.DialContext(ctx, cfg.WSURL)
        if err != nil {
            log.Warn("websocket connection failed, falling back to polling",
                "error", err)
        } else {
            c.ws = wsClient
        }
    }

    return c, nil
}

// Close disconnects all clients
func (c *Client) Close() {
    c.http.Close()
    if c.ws != nil {
        c.ws.Close()
    }
}

// ChainID returns the chain ID this client is connected to
func (c *Client) ChainID() *big.Int {
    return new(big.Int).Set(c.chainID)
}

// HTTPClient returns the underlying ethclient for direct queries
func (c *Client) HTTPClient() *ethclient.Client {
    return c.http
}

// WSClient returns the WebSocket client (may be nil)
func (c *Client) WSClient() *ethclient.Client {
    return c.ws
}

// withRetry executes an operation with retry logic
func (c *Client) withRetry(ctx context.Context, op func() error) error {
    var lastErr error
    for attempt := 0; attempt < c.cfg.MaxRetries; attempt++ {
        if attempt > 0 {
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(c.cfg.RetryDelay * time.Duration(attempt)):
            }
        }
        if err := op(); err != nil {
            lastErr = err
            c.log.Warn("rpc call failed, retrying",
                "attempt", attempt+1,
                "max_retries", c.cfg.MaxRetries,
                "error", err,
            )
            continue
        }
        return nil
    }
    return fmt.Errorf("all %d attempts failed: %w", c.cfg.MaxRetries, lastErr)
}
```

### Querying Blockchain State

```go
// query/state.go
package query

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// BlockchainQuery provides read-only access to Ethereum state
type BlockchainQuery struct {
    client *ethclient.Client
}

// NewBlockchainQuery creates a query interface
func NewBlockchainQuery(client *ethclient.Client) *BlockchainQuery {
    return &BlockchainQuery{client: client}
}

// GetBalance returns the native token balance of an address in wei
func (q *BlockchainQuery) GetBalance(ctx context.Context, address string) (*big.Int, error) {
    addr := common.HexToAddress(address)
    balance, err := q.client.BalanceAt(ctx, addr, nil) // nil = latest block
    if err != nil {
        return nil, fmt.Errorf("get balance for %s: %w", address, err)
    }
    return balance, nil
}

// GetERC20Balance queries an ERC20 token balance
// This uses a raw call — see the contract section for ABI-based approach
func (q *BlockchainQuery) GetERC20Balance(
    ctx context.Context,
    tokenAddress string,
    holderAddress string,
) (*big.Int, error) {
    token := common.HexToAddress(tokenAddress)
    holder := common.HexToAddress(holderAddress)

    // ERC20 balanceOf(address) selector: 0x70a08231
    // Encode: selector + left-padded address (32 bytes)
    data := make([]byte, 36)
    copy(data[0:4], []byte{0x70, 0xa0, 0x82, 0x31})
    copy(data[16:36], holder.Bytes())

    result, err := q.client.CallContract(ctx,
        ethereum.CallMsg{
            To:   &token,
            Data: data,
        },
        nil, // latest block
    )
    if err != nil {
        return nil, fmt.Errorf("call balanceOf: %w", err)
    }

    if len(result) != 32 {
        return nil, fmt.Errorf("unexpected response length: %d", len(result))
    }

    balance := new(big.Int).SetBytes(result)
    return balance, nil
}

// GetTransactionReceipt fetches a transaction receipt with confirmation checking
func (q *BlockchainQuery) GetTransactionReceipt(
    ctx context.Context,
    txHash string,
) (*types.Receipt, error) {
    hash := common.HexToHash(txHash)
    receipt, err := q.client.TransactionReceipt(ctx, hash)
    if err != nil {
        return nil, fmt.Errorf("get receipt for %s: %w", txHash, err)
    }
    return receipt, nil
}

// WaitForConfirmation polls until a transaction has the required number of confirmations
func (q *BlockchainQuery) WaitForConfirmation(
    ctx context.Context,
    txHash string,
    requiredConfirmations uint64,
    pollInterval time.Duration,
) (*types.Receipt, error) {
    hash := common.HexToHash(txHash)

    ticker := time.NewTicker(pollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-ticker.C:
        }

        receipt, err := q.client.TransactionReceipt(ctx, hash)
        if err != nil {
            // Transaction not yet mined
            continue
        }

        if receipt.Status == types.ReceiptStatusFailed {
            return receipt, fmt.Errorf("transaction %s reverted", txHash)
        }

        currentBlock, err := q.client.BlockNumber(ctx)
        if err != nil {
            continue
        }

        confirmations := currentBlock - receipt.BlockNumber.Uint64()
        if confirmations >= requiredConfirmations {
            return receipt, nil
        }
    }
}
```

### Smart Contract Interaction with ABI

```go
// contract/erc20.go
package contract

import (
    "context"
    "fmt"
    "math/big"
    "strings"

    "github.com/ethereum/go-ethereum"
    "github.com/ethereum/go-ethereum/accounts/abi"
    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// ERC20ABI is the minimal ABI for ERC20 tokens
const ERC20ABI = `[
    {"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"name":"transfer","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"}],"name":"transferFrom","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"name":"spender","type":"address"},{"name":"value","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[],"name":"totalSupply","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"indexed":true,"name":"from","type":"address"},{"indexed":true,"name":"to","type":"address"},{"name":"value","type":"uint256"}],"name":"Transfer","type":"event"}
]`

// ERC20Contract wraps ERC20 token interactions
type ERC20Contract struct {
    address common.Address
    abi     abi.ABI
    client  *ethclient.Client
    bound   *bind.BoundContract
}

// NewERC20Contract creates a new ERC20 contract wrapper
func NewERC20Contract(address string, client *ethclient.Client) (*ERC20Contract, error) {
    parsed, err := abi.JSON(strings.NewReader(ERC20ABI))
    if err != nil {
        return nil, fmt.Errorf("parse abi: %w", err)
    }

    addr := common.HexToAddress(address)
    bound := bind.NewBoundContract(addr, parsed, client, client, client)

    return &ERC20Contract{
        address: addr,
        abi:     parsed,
        client:  client,
        bound:   bound,
    }, nil
}

// BalanceOf returns the token balance of an address
func (e *ERC20Contract) BalanceOf(ctx context.Context, owner string) (*big.Int, error) {
    var result []interface{}
    err := e.bound.Call(
        &bind.CallOpts{Context: ctx},
        &result,
        "balanceOf",
        common.HexToAddress(owner),
    )
    if err != nil {
        return nil, fmt.Errorf("balanceOf call: %w", err)
    }
    if len(result) == 0 {
        return nil, fmt.Errorf("empty result from balanceOf")
    }
    balance, ok := result[0].(*big.Int)
    if !ok {
        return nil, fmt.Errorf("unexpected result type: %T", result[0])
    }
    return balance, nil
}

// Symbol returns the token symbol
func (e *ERC20Contract) Symbol(ctx context.Context) (string, error) {
    var result []interface{}
    if err := e.bound.Call(
        &bind.CallOpts{Context: ctx},
        &result,
        "symbol",
    ); err != nil {
        return "", fmt.Errorf("symbol call: %w", err)
    }
    if len(result) == 0 {
        return "", fmt.Errorf("empty symbol result")
    }
    return result[0].(string), nil
}

// BuildTransferTx builds an unsigned transfer transaction
// The caller is responsible for signing — keys never enter this function
func (e *ERC20Contract) BuildTransferTx(
    ctx context.Context,
    fromAddress string,
    toAddress string,
    amount *big.Int,
    gasPrice *big.Int,
    nonce uint64,
    chainID *big.Int,
) (*types.Transaction, error) {
    packed, err := e.abi.Pack("transfer",
        common.HexToAddress(toAddress),
        amount,
    )
    if err != nil {
        return nil, fmt.Errorf("pack transfer: %w", err)
    }

    // Estimate gas
    from := common.HexToAddress(fromAddress)
    to := e.address
    gas, err := e.client.EstimateGas(ctx, ethereum.CallMsg{
        From:     from,
        To:       &to,
        GasPrice: gasPrice,
        Data:     packed,
    })
    if err != nil {
        return nil, fmt.Errorf("estimate gas: %w", err)
    }

    // Add 20% buffer to gas estimate
    gas = gas * 120 / 100

    tx := types.NewTransaction(
        nonce,
        e.address,
        big.NewInt(0), // no ETH value for ERC20 transfer
        gas,
        gasPrice,
        packed,
    )

    return tx, nil
}

// ParseTransferEvent parses Transfer events from a transaction receipt
func (e *ERC20Contract) ParseTransferEvents(receipt *types.Receipt) ([]TransferEvent, error) {
    var events []TransferEvent

    transferEventABI := e.abi.Events["Transfer"]
    transferSig := transferEventABI.ID

    for _, log := range receipt.Logs {
        if log.Address != e.address {
            continue
        }
        if len(log.Topics) == 0 || log.Topics[0] != transferSig {
            continue
        }

        // Topics[1] = from (indexed), Topics[2] = to (indexed)
        // Data = value (non-indexed)
        if len(log.Topics) < 3 {
            continue
        }

        from := common.BytesToAddress(log.Topics[1].Bytes())
        to := common.BytesToAddress(log.Topics[2].Bytes())

        values, err := e.abi.Unpack("Transfer", log.Data)
        if err != nil {
            continue
        }
        value, ok := values[0].(*big.Int)
        if !ok {
            continue
        }

        events = append(events, TransferEvent{
            From:  from.Hex(),
            To:    to.Hex(),
            Value: value,
            TxHash: receipt.TxHash.Hex(),
            Block:  receipt.BlockNumber.Uint64(),
        })
    }

    return events, nil
}

// TransferEvent represents a parsed ERC20 Transfer event
type TransferEvent struct {
    From   string
    To     string
    Value  *big.Int
    TxHash string
    Block  uint64
}
```

### Event Subscriptions

```go
// subscription/events.go
package subscription

import (
    "context"
    "fmt"
    "log/slog"
    "strings"

    "github.com/ethereum/go-ethereum"
    "github.com/ethereum/go-ethereum/accounts/abi"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// EventSubscriber manages blockchain event subscriptions
type EventSubscriber struct {
    client *ethclient.Client   // must be WebSocket client
    log    *slog.Logger
}

// NewEventSubscriber creates a new event subscriber
// client MUST be connected via WebSocket (wss://)
func NewEventSubscriber(wsClient *ethclient.Client, log *slog.Logger) *EventSubscriber {
    return &EventSubscriber{client: wsClient, log: log}
}

// SubscribeToTransfers subscribes to ERC20 Transfer events
func (s *EventSubscriber) SubscribeToTransfers(
    ctx context.Context,
    contractAddress string,
    handler func(event TransferEvent),
) error {
    parsedABI, err := abi.JSON(strings.NewReader(ERC20ABI))
    if err != nil {
        return fmt.Errorf("parse abi: %w", err)
    }

    transferEventID := parsedABI.Events["Transfer"].ID

    query := ethereum.FilterQuery{
        Addresses: []common.Address{
            common.HexToAddress(contractAddress),
        },
        Topics: [][]common.Hash{
            {transferEventID},
        },
    }

    logsCh := make(chan types.Log, 100)
    sub, err := s.client.SubscribeFilterLogs(ctx, query, logsCh)
    if err != nil {
        return fmt.Errorf("subscribe filter logs: %w", err)
    }

    go func() {
        defer sub.Unsubscribe()
        for {
            select {
            case <-ctx.Done():
                s.log.Info("event subscription stopped", "contract", contractAddress)
                return

            case err := <-sub.Err():
                if err != nil {
                    s.log.Error("subscription error", "error", err)
                    // Reconnection logic would go here
                }
                return

            case vLog := <-logsCh:
                if len(vLog.Topics) < 3 {
                    continue
                }
                from := common.BytesToAddress(vLog.Topics[1].Bytes())
                to := common.BytesToAddress(vLog.Topics[2].Bytes())

                values, err := parsedABI.Unpack("Transfer", vLog.Data)
                if err != nil || len(values) == 0 {
                    continue
                }

                handler(TransferEvent{
                    From:        from.Hex(),
                    To:          to.Hex(),
                    Value:       values[0].(*big.Int),
                    TxHash:      vLog.TxHash.Hex(),
                    Block:       vLog.BlockNumber,
                    BlockHash:   vLog.BlockHash.Hex(),
                    LogIndex:    vLog.Index,
                    Removed:     vLog.Removed,
                })
            }
        }
    }()

    return nil
}

// SubscribeToNewBlocks subscribes to new block headers
func (s *EventSubscriber) SubscribeToNewBlocks(
    ctx context.Context,
    handler func(header *types.Header),
) error {
    headers := make(chan *types.Header, 10)
    sub, err := s.client.SubscribeNewHead(ctx, headers)
    if err != nil {
        return fmt.Errorf("subscribe new head: %w", err)
    }

    go func() {
        defer sub.Unsubscribe()
        for {
            select {
            case <-ctx.Done():
                return
            case err := <-sub.Err():
                s.log.Error("new head subscription error", "error", err)
                return
            case header := <-headers:
                s.log.Debug("new block",
                    "number", header.Number.Uint64(),
                    "hash", header.Hash().Hex(),
                    "time", header.Time,
                )
                handler(header)
            }
        }
    }()

    return nil
}
```

### Secure Transaction Signing

The cardinal rule of blockchain backend services is that private keys must never be stored in application memory during normal operation. Use a hardware security module (HSM), a key management service (KMS), or an external signer.

```go
// signer/kms.go — AWS KMS-backed transaction signer
package signer

import (
    "context"
    "crypto/ecdsa"
    "fmt"
    "math/big"

    "github.com/aws/aws-sdk-go-v2/service/kms"
    "github.com/ethereum/go-ethereum/accounts"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/crypto"
)

// KMSSigner signs Ethereum transactions using AWS KMS
// The private key material never leaves the KMS HSM.
type KMSSigner struct {
    kmsClient *kms.Client
    keyID     string      // KMS key ARN or alias
    address   common.Address
    chainID   *big.Int
    publicKey *ecdsa.PublicKey
}

// NewKMSSigner creates a KMS-backed signer
// keyID: KMS key ARN (must be secp256k1 key type)
func NewKMSSigner(
    ctx context.Context,
    kmsClient *kms.Client,
    keyID string,
    chainID *big.Int,
) (*KMSSigner, error) {
    // Fetch the public key from KMS
    pubKeyResp, err := kmsClient.GetPublicKey(ctx, &kms.GetPublicKeyInput{
        KeyId: &keyID,
    })
    if err != nil {
        return nil, fmt.Errorf("get kms public key: %w", err)
    }

    // Parse the DER-encoded public key
    pubKey, err := parseKMSPublicKey(pubKeyResp.PublicKey)
    if err != nil {
        return nil, fmt.Errorf("parse public key: %w", err)
    }

    address := crypto.PubkeyToAddress(*pubKey)

    return &KMSSigner{
        kmsClient: kmsClient,
        keyID:     keyID,
        address:   address,
        chainID:   chainID,
        publicKey: pubKey,
    }, nil
}

// Address returns the Ethereum address corresponding to this signer's key
func (s *KMSSigner) Address() common.Address {
    return s.address
}

// SignTransaction signs a transaction using KMS
func (s *KMSSigner) SignTransaction(
    ctx context.Context,
    tx *types.Transaction,
) (*types.Transaction, error) {
    signer := types.NewLondonSigner(s.chainID)
    txHash := signer.Hash(tx)

    // Request KMS to sign the hash
    // KMS signs with the ECDSA_SHA_256 algorithm for secp256k1 keys
    signResp, err := s.kmsClient.Sign(ctx, &kms.SignInput{
        KeyId:            &s.keyID,
        Message:          txHash.Bytes(),
        MessageType:      kmsTypes.MessageTypeDigest,
        SigningAlgorithm: kmsTypes.SigningAlgorithmSpecEcdsaSha256,
    })
    if err != nil {
        return nil, fmt.Errorf("kms sign: %w", err)
    }

    // Convert DER-encoded signature to Ethereum's [R || S || V] format
    r, sv, err := parseDERSignature(signResp.Signature)
    if err != nil {
        return nil, fmt.Errorf("parse signature: %w", err)
    }

    // Recover the correct V value by trying both options
    sig := make([]byte, 65)
    copy(sig[0:32], r.Bytes())
    copy(sig[32:64], sv.Bytes())

    // Try V=0
    sig[64] = 0
    recovered, err := crypto.Ecrecover(txHash.Bytes(), sig)
    if err != nil || !bytes.Equal(recovered[12:], s.address.Bytes()) {
        // Try V=1
        sig[64] = 1
        recovered, err = crypto.Ecrecover(txHash.Bytes(), sig)
        if err != nil {
            return nil, fmt.Errorf("cannot determine signature V value")
        }
        if !bytes.Equal(recovered[12:], s.address.Bytes()) {
            return nil, fmt.Errorf("signature recovery failed: address mismatch")
        }
    }

    signedTx, err := tx.WithSignature(signer, sig)
    if err != nil {
        return nil, fmt.Errorf("attach signature: %w", err)
    }

    return signedTx, nil
}

// parseDERSignature converts DER-encoded ECDSA signature to R and S components
func parseDERSignature(der []byte) (r, s *big.Int, err error) {
    // DER format: 0x30 [total-len] 0x02 [r-len] [r-bytes] 0x02 [s-len] [s-bytes]
    if len(der) < 8 || der[0] != 0x30 {
        return nil, nil, fmt.Errorf("invalid DER signature")
    }

    // Parse R
    rLen := int(der[3])
    if 4+rLen > len(der) {
        return nil, nil, fmt.Errorf("invalid R length in DER")
    }
    r = new(big.Int).SetBytes(der[4 : 4+rLen])

    // Parse S
    sOffset := 4 + rLen
    if sOffset+2 > len(der) || der[sOffset] != 0x02 {
        return nil, nil, fmt.Errorf("invalid S tag in DER")
    }
    sLen := int(der[sOffset+1])
    if sOffset+2+sLen > len(der) {
        return nil, nil, fmt.Errorf("invalid S length in DER")
    }
    s = new(big.Int).SetBytes(der[sOffset+2 : sOffset+2+sLen])

    return r, s, nil
}
```

## Solana JSON-RPC Client

Solana does not have a first-party Go client with the maturity of go-ethereum. The primary option is building directly on top of the JSON-RPC API using the `gagliardetto/solana-go` library.

```bash
go get github.com/gagliardetto/solana-go@v1.11.0
```

### Solana Client Setup

```go
// solana/client.go
package solana

import (
    "context"
    "fmt"
    "time"

    solanago "github.com/gagliardetto/solana-go"
    "github.com/gagliardetto/solana-go/rpc"
    "github.com/gagliardetto/solana-go/rpc/ws"
)

// Client wraps the Solana RPC client
type Client struct {
    rpc     *rpc.Client
    ws      *ws.Client
    cluster string
}

// NewClient creates a Solana client
func NewClient(ctx context.Context, rpcURL, wsURL string) (*Client, error) {
    rpcClient := rpc.New(rpcURL)

    // Verify connectivity
    version, err := rpcClient.GetVersion(ctx)
    if err != nil {
        return nil, fmt.Errorf("get solana version: %w", err)
    }

    c := &Client{
        rpc:     rpcClient,
        cluster: rpcURL,
    }

    // Connect WebSocket for subscriptions
    if wsURL != "" {
        wsClient, err := ws.Connect(ctx, wsURL)
        if err != nil {
            // Non-fatal — fall back to polling
            _ = version
        } else {
            c.ws = wsClient
        }
    }

    return c, nil
}

// GetBalance returns SOL balance in lamports (1 SOL = 1e9 lamports)
func (c *Client) GetBalance(ctx context.Context, address string) (uint64, error) {
    pubkey, err := solanago.PublicKeyFromBase58(address)
    if err != nil {
        return 0, fmt.Errorf("parse address %s: %w", address, err)
    }

    resp, err := c.rpc.GetBalance(
        ctx,
        pubkey,
        rpc.CommitmentFinalized,
    )
    if err != nil {
        return 0, fmt.Errorf("get balance: %w", err)
    }

    return resp.Value, nil
}

// GetTokenAccountBalance returns the balance of an SPL token account
func (c *Client) GetTokenAccountBalance(
    ctx context.Context,
    tokenAccountAddress string,
) (*rpc.UiTokenAmount, error) {
    pubkey, err := solanago.PublicKeyFromBase58(tokenAccountAddress)
    if err != nil {
        return nil, fmt.Errorf("parse token account address: %w", err)
    }

    resp, err := c.rpc.GetTokenAccountBalance(
        ctx,
        pubkey,
        rpc.CommitmentFinalized,
    )
    if err != nil {
        return nil, fmt.Errorf("get token balance: %w", err)
    }

    return resp.Value, nil
}

// GetSlot returns the current confirmed slot
func (c *Client) GetSlot(ctx context.Context) (uint64, error) {
    slot, err := c.rpc.GetSlot(ctx, rpc.CommitmentConfirmed)
    if err != nil {
        return 0, fmt.Errorf("get slot: %w", err)
    }
    return slot, nil
}

// GetTransaction fetches a confirmed transaction
func (c *Client) GetTransaction(
    ctx context.Context,
    signature string,
) (*rpc.GetTransactionResult, error) {
    sig, err := solanago.SignatureFromBase58(signature)
    if err != nil {
        return nil, fmt.Errorf("parse signature: %w", err)
    }

    maxVersion := uint64(0)
    resp, err := c.rpc.GetTransaction(
        ctx,
        sig,
        &rpc.GetTransactionOpts{
            Encoding:                       solanago.EncodingJSON,
            Commitment:                     rpc.CommitmentFinalized,
            MaxSupportedTransactionVersion: &maxVersion,
        },
    )
    if err != nil {
        return nil, fmt.Errorf("get transaction %s: %w", signature, err)
    }

    return resp, nil
}

// WaitForConfirmation polls until a transaction reaches Finalized status
func (c *Client) WaitForConfirmation(
    ctx context.Context,
    signature string,
    timeout time.Duration,
) error {
    sig, err := solanago.SignatureFromBase58(signature)
    if err != nil {
        return fmt.Errorf("parse signature: %w", err)
    }

    deadline := time.Now().Add(timeout)
    ticker := time.NewTicker(2 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
        }

        if time.Now().After(deadline) {
            return fmt.Errorf("timeout waiting for confirmation of %s", signature)
        }

        statuses, err := c.rpc.GetSignatureStatuses(ctx,
            true, // searchTransactionHistory
            sig,
        )
        if err != nil || len(statuses.Value) == 0 {
            continue
        }

        status := statuses.Value[0]
        if status == nil {
            continue
        }

        if status.Err != nil {
            return fmt.Errorf("transaction failed: %v", status.Err)
        }

        if status.ConfirmationStatus == rpc.ConfirmationStatusFinalized {
            return nil
        }
    }
}
```

### Subscribing to Solana Account Changes

```go
// solana/subscription.go
package solana

import (
    "context"
    "fmt"
    "log/slog"

    solanago "github.com/gagliardetto/solana-go"
    "github.com/gagliardetto/solana-go/rpc"
    "github.com/gagliardetto/solana-go/rpc/ws"
)

// AccountSubscriber watches for Solana account state changes
type AccountSubscriber struct {
    wsClient *ws.Client
    log      *slog.Logger
}

// SubscribeToAccountChanges receives notifications when an account's data changes
func (s *AccountSubscriber) SubscribeToAccountChanges(
    ctx context.Context,
    accountAddress string,
    handler func(account *rpc.KeyedAccount),
) error {
    pubkey, err := solanago.PublicKeyFromBase58(accountAddress)
    if err != nil {
        return fmt.Errorf("parse address: %w", err)
    }

    sub, err := s.wsClient.AccountSubscribe(
        pubkey,
        rpc.CommitmentConfirmed,
    )
    if err != nil {
        return fmt.Errorf("account subscribe: %w", err)
    }

    go func() {
        defer sub.Unsubscribe()
        for {
            select {
            case <-ctx.Done():
                return
            default:
            }

            result, err := sub.Recv(ctx)
            if err != nil {
                s.log.Error("account subscription error",
                    "address", accountAddress,
                    "error", err,
                )
                return
            }

            handler(&result.Value)
        }
    }()

    return nil
}

// SubscribeToLogs subscribes to transaction logs matching a filter
func (s *AccountSubscriber) SubscribeToLogs(
    ctx context.Context,
    programID string,
    handler func(logs *ws.LogResult),
) error {
    prog, err := solanago.PublicKeyFromBase58(programID)
    if err != nil {
        return fmt.Errorf("parse program id: %w", err)
    }

    filter := ws.LogsSubscribeFilterMentions(prog)
    sub, err := s.wsClient.LogsSubscribe(filter, rpc.CommitmentConfirmed)
    if err != nil {
        return fmt.Errorf("logs subscribe: %w", err)
    }

    go func() {
        defer sub.Unsubscribe()
        for {
            select {
            case <-ctx.Done():
                return
            default:
            }

            result, err := sub.Recv(ctx)
            if err != nil {
                s.log.Error("logs subscription error", "error", err)
                return
            }
            handler(result)
        }
    }()

    return nil
}
```

## Transaction Nonce Management

Ethereum transaction nonces must be sequential with no gaps. In a service that sends many transactions concurrently, nonce management is a critical concern.

```go
// nonce/manager.go
package nonce

import (
    "context"
    "fmt"
    "sync"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// Manager manages transaction nonces to prevent conflicts
type Manager struct {
    mu      sync.Mutex
    client  *ethclient.Client
    pending map[common.Address]uint64
}

// NewManager creates a nonce manager
func NewManager(client *ethclient.Client) *Manager {
    return &Manager{
        client:  client,
        pending: make(map[common.Address]uint64),
    }
}

// NextNonce returns the next nonce to use for a given address
// It tracks in-flight transactions to avoid reuse
func (m *Manager) NextNonce(ctx context.Context, address common.Address) (uint64, error) {
    m.mu.Lock()
    defer m.mu.Unlock()

    // Get nonce from network (pending state)
    networkNonce, err := m.client.PendingNonceAt(ctx, address)
    if err != nil {
        return 0, fmt.Errorf("get pending nonce for %s: %w", address.Hex(), err)
    }

    // Use the higher of network nonce and our tracked nonce
    tracked, exists := m.pending[address]
    if !exists || networkNonce > tracked {
        m.pending[address] = networkNonce
    }

    nonce := m.pending[address]
    m.pending[address]++
    return nonce, nil
}

// MarkConfirmed removes a transaction from pending tracking
// Call this after a transaction is confirmed or dropped
func (m *Manager) MarkConfirmed(address common.Address, nonce uint64) {
    m.mu.Lock()
    defer m.mu.Unlock()
    if current, ok := m.pending[address]; ok && nonce >= current {
        delete(m.pending, address)
    }
}

// Reset forces re-fetching nonce from network (use when transactions are dropped)
func (m *Manager) Reset(address common.Address) {
    m.mu.Lock()
    defer m.mu.Unlock()
    delete(m.pending, address)
}
```

## Observability for Blockchain Services

```go
// metrics/blockchain.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    TransactionsSent = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "blockchain_transactions_sent_total",
            Help: "Total number of transactions sent to the blockchain",
        },
        []string{"network", "status"},
    )

    TransactionConfirmationDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "blockchain_transaction_confirmation_seconds",
            Help:    "Time to confirmation for blockchain transactions",
            Buckets: []float64{5, 15, 30, 60, 120, 300, 600},
        },
        []string{"network"},
    )

    RPCCallDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "blockchain_rpc_call_duration_seconds",
            Help:    "Duration of blockchain RPC calls",
            Buckets: prometheus.DefBuckets,
        },
        []string{"network", "method"},
    )

    BlockHeight = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "blockchain_block_height",
            Help: "Current block height seen by the service",
        },
        []string{"network"},
    )

    RPCErrors = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "blockchain_rpc_errors_total",
            Help: "Total number of RPC errors",
        },
        []string{"network", "method", "error_type"},
    )

    GasPrice = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "blockchain_gas_price_gwei",
            Help: "Current gas price in Gwei",
        },
        []string{"network"},
    )
)
```

## Key Takeaways

Building production blockchain integrations in Go requires the same engineering rigor as any other backend service, plus additional disciplines specific to the immutable, adversarial nature of blockchain systems.

The most important rule is that private keys must never exist in application memory. Use AWS KMS, HashiCorp Vault's transit secrets engine, or a dedicated hardware security module for all signing operations. The KMS signer pattern shown in this guide — where the application sends the transaction hash to KMS and receives a signature back — ensures that a memory dump, log file, or debug output of the application can never expose key material.

Nonce management for Ethereum transactions is subtle but critical. In a service that sends transactions concurrently, naive nonce fetching will produce duplicate nonces, causing all but one transaction to fail. The nonce manager pattern shown here provides serialized nonce allocation that handles concurrent transaction submission correctly.

Event subscriptions via WebSocket are more efficient than polling for high-frequency event processing. However, WebSocket connections to blockchain nodes are less reliable than HTTP connections. Build your subscription code with reconnection logic and a fallback to polling when WebSocket connectivity fails.

For Solana, the Finalized commitment level is the equivalent of Ethereum's "confirmed" state but takes much longer than Confirmed. Match the commitment level to your application's security requirements: Confirmed is appropriate for user-facing operations where speed matters, Finalized for financial operations where irreversibility is critical.
