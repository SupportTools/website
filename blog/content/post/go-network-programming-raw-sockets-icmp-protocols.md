---
title: "Go Network Programming: Raw Sockets, ICMP, and Custom Protocol Implementation"
date: 2031-03-18T00:00:00-05:00
draft: false
tags: ["Go", "Networking", "ICMP", "Raw Sockets", "Protocols", "Performance"]
categories:
- Go
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to low-level Go network programming: net.Conn vs syscall sockets, ICMP ping implementation with golang.org/x/net/icmp, raw socket privileges, binary protocol parsing, and building a custom UDP protocol handler."
more_link: "yes"
url: "/go-network-programming-raw-sockets-icmp-protocols/"
---

Most Go network code operates at the abstraction level of HTTP clients, gRPC connections, or TCP listeners. But systems programming, network monitoring, and custom protocol development require dropping below these abstractions to work with raw IP packets, ICMP messages, or custom binary protocols. Go provides a surprisingly complete set of primitives for this work, from the high-level `net` package through syscall-level socket creation. This guide covers the full spectrum with working implementations of ICMP ping, raw socket programming, binary protocol parsing, and a complete custom UDP protocol.

<!--more-->

# Go Network Programming: Raw Sockets, ICMP, and Custom Protocol Implementation

## Section 1: The Go Network Stack Hierarchy

Go's network abstractions form a layered hierarchy, each appropriate for different use cases:

```
Application Layer:
  net/http, google.golang.org/grpc      ← Most application code
  net.Conn (TCP/UDP via Dial/Listen)    ← Most service-level code

Transport Layer:
  golang.org/x/net/icmp                 ← ICMP (needs privileged access)
  net.IPConn                            ← Raw IP socket
  net.UDPConn                           ← UDP with full control

Network Layer:
  golang.org/x/net/ipv4/ipv6           ← Packet-level IP control

OS Socket Interface:
  syscall.Socket, syscall.Bind, etc.   ← Direct OS socket API
  golang.org/x/sys/unix                ← POSIX socket extensions
```

The right level to work at depends on your requirements. For an ICMP ping, `golang.org/x/net/icmp` is the right choice. For a custom L3 protocol, you need raw sockets. For a high-performance UDP server, `net.UDPConn` with manual buffer management is appropriate.

## Section 2: ICMP Ping with golang.org/x/net/icmp

ICMP (Internet Control Message Protocol) is the protocol behind `ping` and many network diagnostic tools. Raw ICMP access requires either root privileges or `CAP_NET_RAW`.

### Basic ICMP Ping Implementation

```go
package icmpping

import (
    "context"
    "encoding/binary"
    "fmt"
    "math/rand"
    "net"
    "os"
    "sync"
    "time"

    "golang.org/x/net/icmp"
    "golang.org/x/net/ipv4"
    "golang.org/x/net/ipv6"
)

const (
    icmpv4EchoRequest = 8
    icmpv4EchoReply   = 0
    icmpv6EchoRequest = 128
    icmpv6EchoReply   = 129
)

// PingResult holds the result of a single ping attempt.
type PingResult struct {
    Target   string
    RTT      time.Duration
    Seq      int
    TTL      int
    PacketID int
    Error    error
}

// Pinger sends ICMP echo requests and receives replies.
type Pinger struct {
    id      int
    seq     int
    mu      sync.Mutex
    pending map[int]chan PingResult // seq -> result channel
}

// NewPinger creates a new Pinger with a random identifier.
func NewPinger() *Pinger {
    return &Pinger{
        id:      rand.Intn(0xffff),
        pending: make(map[int]chan PingResult),
    }
}

// Ping sends a single ICMP echo request and waits for a reply.
func (p *Pinger) Ping(ctx context.Context, target string, timeout time.Duration) PingResult {
    addr, err := net.ResolveIPAddr("ip4", target)
    if err != nil {
        return PingResult{Target: target, Error: fmt.Errorf("resolve %s: %w", target, err)}
    }

    // Open raw ICMP socket
    // "ip4:icmp" requires root or CAP_NET_RAW
    // "udp4" uses unprivileged ICMP (Linux 3.11+)
    conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
    if err != nil {
        // Try unprivileged mode
        conn, err = icmp.ListenPacket("udp4", "0.0.0.0")
        if err != nil {
            return PingResult{Target: target, Error: fmt.Errorf("open ICMP socket: %w", err)}
        }
    }
    defer conn.Close()

    p.mu.Lock()
    seq := p.seq
    p.seq++
    resultCh := make(chan PingResult, 1)
    p.pending[seq] = resultCh
    p.mu.Unlock()

    defer func() {
        p.mu.Lock()
        delete(p.pending, seq)
        p.mu.Unlock()
    }()

    // Build ICMP echo request
    msg := &icmp.Message{
        Type: ipv4.ICMPTypeEcho,
        Code: 0,
        Body: &icmp.Echo{
            ID:   p.id,
            Seq:  seq,
            Data: makePayload(seq),
        },
    }

    msgBytes, err := msg.Marshal(nil)
    if err != nil {
        return PingResult{Target: target, Error: fmt.Errorf("marshal ICMP: %w", err)}
    }

    // Record send time and send packet
    sendTime := time.Now()
    if _, err := conn.WriteTo(msgBytes, addr); err != nil {
        return PingResult{Target: target, Error: fmt.Errorf("send ICMP: %w", err)}
    }

    // Wait for reply
    deadline := time.Now().Add(timeout)
    conn.SetReadDeadline(deadline)

    buf := make([]byte, 1500)
    for {
        n, peer, err := conn.ReadFrom(buf)
        if err != nil {
            if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
                return PingResult{Target: target, Error: fmt.Errorf("timeout after %v", timeout)}
            }
            return PingResult{Target: target, Error: fmt.Errorf("read: %w", err)}
        }

        // Parse the received ICMP message
        proto := 1 // ICMPv4
        rm, err := icmp.ParseMessage(proto, buf[:n])
        if err != nil {
            continue // Not an ICMP message we understand
        }

        // Check if this is our echo reply
        if rm.Type == ipv4.ICMPTypeEchoReply {
            echo, ok := rm.Body.(*icmp.Echo)
            if !ok {
                continue
            }
            if echo.ID == p.id && echo.Seq == seq {
                rtt := time.Since(sendTime)
                _ = peer // We have the responder address if needed
                return PingResult{
                    Target:   target,
                    RTT:      rtt,
                    Seq:      seq,
                    PacketID: echo.ID,
                }
            }
        }

        // Check for timeout
        if time.Now().After(deadline) {
            return PingResult{Target: target, Error: fmt.Errorf("timeout")}
        }
    }
}

func makePayload(seq int) []byte {
    // Create a 32-byte payload with timestamp for independent RTT calculation
    payload := make([]byte, 32)
    ts := time.Now().UnixNano()
    binary.BigEndian.PutUint64(payload[0:8], uint64(ts))
    binary.BigEndian.PutUint32(payload[8:12], uint32(seq))
    return payload
}
```

### Concurrent Multi-Target Ping

```go
package icmpping

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// PingAll pings multiple targets concurrently and returns all results.
func PingAll(ctx context.Context, targets []string, count int, interval, timeout time.Duration) map[string][]PingResult {
    results := make(map[string][]PingResult, len(targets))
    var mu sync.Mutex
    var wg sync.WaitGroup

    for _, target := range targets {
        wg.Add(1)
        go func(t string) {
            defer wg.Done()
            pinger := NewPinger()
            var targetResults []PingResult

            for i := 0; i < count; i++ {
                select {
                case <-ctx.Done():
                    return
                default:
                }

                result := pinger.Ping(ctx, t, timeout)
                targetResults = append(targetResults, result)

                if i < count-1 {
                    time.Sleep(interval)
                }
            }

            mu.Lock()
            results[t] = targetResults
            mu.Unlock()
        }(target)
    }

    wg.Wait()
    return results
}

// PingSummary provides statistics for a set of ping results.
type PingSummary struct {
    Target   string
    Sent     int
    Received int
    Loss     float64
    MinRTT   time.Duration
    MaxRTT   time.Duration
    AvgRTT   time.Duration
}

func Summarize(target string, results []PingResult) PingSummary {
    summary := PingSummary{
        Target: target,
        Sent:   len(results),
    }

    var totalRTT time.Duration
    summary.MinRTT = time.Duration(1<<63 - 1) // max duration

    for _, r := range results {
        if r.Error != nil {
            continue
        }
        summary.Received++
        totalRTT += r.RTT
        if r.RTT < summary.MinRTT {
            summary.MinRTT = r.RTT
        }
        if r.RTT > summary.MaxRTT {
            summary.MaxRTT = r.RTT
        }
    }

    if summary.Received > 0 {
        summary.AvgRTT = totalRTT / time.Duration(summary.Received)
    }

    if summary.Sent > 0 {
        summary.Loss = float64(summary.Sent-summary.Received) / float64(summary.Sent) * 100
    }

    return summary
}

func main() {
    ctx := context.Background()
    targets := []string{"8.8.8.8", "1.1.1.1", "192.168.1.1"}

    allResults := PingAll(ctx, targets, 5, 100*time.Millisecond, 2*time.Second)

    for target, results := range allResults {
        summary := Summarize(target, results)
        fmt.Printf("--- %s ---\n", summary.Target)
        fmt.Printf("Packets: %d sent, %d received, %.0f%% loss\n",
            summary.Sent, summary.Received, summary.Loss)
        if summary.Received > 0 {
            fmt.Printf("RTT: min=%v avg=%v max=%v\n",
                summary.MinRTT, summary.AvgRTT, summary.MaxRTT)
        }
    }
}
```

### IPv6 ICMP

```go
func pingIPv6(ctx context.Context, target string, timeout time.Duration) (time.Duration, error) {
    addr, err := net.ResolveIPAddr("ip6", target)
    if err != nil {
        return 0, fmt.Errorf("resolve: %w", err)
    }

    conn, err := icmp.ListenPacket("ip6:ipv6-icmp", "::")
    if err != nil {
        return 0, fmt.Errorf("listen: %w", err)
    }
    defer conn.Close()

    id := rand.Intn(0xffff)
    seq := rand.Intn(0xffff)

    msg := &icmp.Message{
        Type: ipv6.ICMPTypeEchoRequest,  // IPv6 uses different types
        Code: 0,
        Body: &icmp.Echo{
            ID:   id,
            Seq:  seq,
            Data: []byte("ping from Go"),
        },
    }

    wb, err := msg.Marshal(nil)
    if err != nil {
        return 0, err
    }

    start := time.Now()
    if _, err := conn.WriteTo(wb, addr); err != nil {
        return 0, err
    }

    conn.SetReadDeadline(time.Now().Add(timeout))
    rb := make([]byte, 1500)

    for {
        n, _, err := conn.ReadFrom(rb)
        if err != nil {
            return 0, err
        }

        rm, err := icmp.ParseMessage(58, rb[:n]) // 58 = IPv6 ICMP protocol number
        if err != nil {
            continue
        }

        if rm.Type == ipv6.ICMPTypeEchoReply {
            if echo, ok := rm.Body.(*icmp.Echo); ok {
                if echo.ID == id && echo.Seq == seq {
                    return time.Since(start), nil
                }
            }
        }
    }
}
```

## Section 3: Raw Socket Creation with syscall

For protocols not covered by the standard library, raw socket creation via syscall provides complete control.

### Raw IPv4 Socket

```go
package rawsocket

import (
    "encoding/binary"
    "fmt"
    "net"
    "syscall"
    "unsafe"
)

// RawSocket wraps a raw IP socket for sending arbitrary IP packets.
type RawSocket struct {
    fd int
}

// NewRawSocketIPv4 creates a raw socket for the specified IP protocol.
// protocol: syscall.IPPROTO_TCP, syscall.IPPROTO_UDP, syscall.IPPROTO_ICMP, etc.
// Requires CAP_NET_RAW or root privileges.
func NewRawSocketIPv4(protocol int) (*RawSocket, error) {
    fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_RAW, protocol)
    if err != nil {
        return nil, fmt.Errorf("socket(): %w", err)
    }

    // Enable IP_HDRINCL to send custom IP headers
    if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_IP, syscall.IP_HDRINCL, 1); err != nil {
        syscall.Close(fd)
        return nil, fmt.Errorf("setsockopt IP_HDRINCL: %w", err)
    }

    return &RawSocket{fd: fd}, nil
}

// IPv4Header represents an IPv4 header.
type IPv4Header struct {
    Version     uint8  // IP version (4)
    HeaderLen   uint8  // Header length in 32-bit words
    TOS         uint8  // Type of service
    TotalLen    uint16 // Total length including header
    ID          uint16 // Identification
    FlagsOffset uint16 // Flags and fragment offset
    TTL         uint8  // Time to live
    Protocol    uint8  // Next protocol
    Checksum    uint16 // Header checksum
    SrcIP       [4]byte
    DstIP       [4]byte
}

func (h *IPv4Header) Marshal() []byte {
    b := make([]byte, 20)
    b[0] = (h.Version << 4) | (h.HeaderLen)
    b[1] = h.TOS
    binary.BigEndian.PutUint16(b[2:4], h.TotalLen)
    binary.BigEndian.PutUint16(b[4:6], h.ID)
    binary.BigEndian.PutUint16(b[6:8], h.FlagsOffset)
    b[8] = h.TTL
    b[9] = h.Protocol
    // b[10:12] = checksum (0 for now, computed below)
    copy(b[12:16], h.SrcIP[:])
    copy(b[16:20], h.DstIP[:])

    // Compute checksum
    checksum := ipChecksum(b)
    binary.BigEndian.PutUint16(b[10:12], checksum)
    return b
}

// ipChecksum computes the IP header checksum.
func ipChecksum(data []byte) uint16 {
    var sum uint32
    for i := 0; i < len(data)-1; i += 2 {
        sum += uint32(data[i])<<8 | uint32(data[i+1])
    }
    if len(data)%2 != 0 {
        sum += uint32(data[len(data)-1]) << 8
    }
    for sum>>16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16)
    }
    return ^uint16(sum)
}

// Send sends a raw IP packet to the destination.
func (s *RawSocket) Send(dst net.IP, payload []byte) error {
    var addr syscall.SockaddrInet4
    copy(addr.Addr[:], dst.To4())

    if err := syscall.Sendto(s.fd, payload, 0, &addr); err != nil {
        return fmt.Errorf("sendto: %w", err)
    }
    return nil
}

// Receive reads the next raw IP packet.
func (s *RawSocket) Receive(buf []byte) (int, *syscall.SockaddrInet4, error) {
    n, from, err := syscall.Recvfrom(s.fd, buf, 0)
    if err != nil {
        return 0, nil, fmt.Errorf("recvfrom: %w", err)
    }
    addr, ok := from.(*syscall.SockaddrInet4)
    if !ok {
        return n, nil, fmt.Errorf("unexpected address type")
    }
    return n, addr, nil
}

func (s *RawSocket) Close() error {
    return syscall.Close(s.fd)
}
```

### Setting Socket Capabilities (CAP_NET_RAW)

```bash
# Grant CAP_NET_RAW to a Go binary without running as root
# This allows raw socket creation without full root access

# Check current capabilities
getcap /usr/local/bin/mynetmon

# Grant raw socket capability
setcap cap_net_raw+ep /usr/local/bin/mynetmon

# Verify
getcap /usr/local/bin/mynetmon
# /usr/local/bin/mynetmon = cap_net_raw+ep
```

```go
// In Docker containers, add the capability
// In Kubernetes pods:
// securityContext:
//   capabilities:
//     add: ["NET_RAW"]
```

## Section 4: Protocol Parsing with encoding/binary

### Parsing TCP Headers

```go
package protocols

import (
    "encoding/binary"
    "fmt"
    "io"
)

// TCPHeader represents a TCP header.
type TCPHeader struct {
    SrcPort    uint16
    DstPort    uint16
    SeqNum     uint32
    AckNum     uint32
    DataOffset uint8  // 4 bits: data offset in 32-bit words
    Reserved   uint8  // 3 bits
    Flags      uint8  // 9 bits: NS, CWR, ECE, URG, ACK, PSH, RST, SYN, FIN
    Window     uint16
    Checksum   uint16
    UrgPtr     uint16
}

const (
    TCPFlagFIN = 1 << 0
    TCPFlagSYN = 1 << 1
    TCPFlagRST = 1 << 2
    TCPFlagPSH = 1 << 3
    TCPFlagACK = 1 << 4
    TCPFlagURG = 1 << 5
)

// ParseTCPHeader parses 20 bytes of TCP header from a byte slice.
func ParseTCPHeader(data []byte) (*TCPHeader, error) {
    if len(data) < 20 {
        return nil, fmt.Errorf("TCP header too short: %d bytes", len(data))
    }

    hdr := &TCPHeader{
        SrcPort:    binary.BigEndian.Uint16(data[0:2]),
        DstPort:    binary.BigEndian.Uint16(data[2:4]),
        SeqNum:     binary.BigEndian.Uint32(data[4:8]),
        AckNum:     binary.BigEndian.Uint32(data[8:12]),
        DataOffset: (data[12] >> 4) & 0xf,
        Reserved:   (data[12] & 0xe) >> 1,
        Flags:      data[13],
        Window:     binary.BigEndian.Uint16(data[14:16]),
        Checksum:   binary.BigEndian.Uint16(data[16:18]),
        UrgPtr:     binary.BigEndian.Uint16(data[18:20]),
    }

    return hdr, nil
}

// Marshal serializes the TCP header to a byte slice.
func (h *TCPHeader) Marshal() []byte {
    b := make([]byte, 20)
    binary.BigEndian.PutUint16(b[0:2], h.SrcPort)
    binary.BigEndian.PutUint16(b[2:4], h.DstPort)
    binary.BigEndian.PutUint32(b[4:8], h.SeqNum)
    binary.BigEndian.PutUint32(b[8:12], h.AckNum)
    b[12] = (h.DataOffset << 4) | (h.Reserved & 0xe >> 1)
    b[13] = h.Flags
    binary.BigEndian.PutUint16(b[14:16], h.Window)
    binary.BigEndian.PutUint16(b[16:18], h.Checksum)
    binary.BigEndian.PutUint16(b[18:20], h.UrgPtr)
    return b
}

func (h *TCPHeader) HasFlag(flag uint8) bool {
    return h.Flags&flag != 0
}

func (h *TCPHeader) String() string {
    flags := ""
    if h.HasFlag(TCPFlagSYN) { flags += "S" }
    if h.HasFlag(TCPFlagACK) { flags += "A" }
    if h.HasFlag(TCPFlagFIN) { flags += "F" }
    if h.HasFlag(TCPFlagRST) { flags += "R" }
    if h.HasFlag(TCPFlagPSH) { flags += "P" }
    return fmt.Sprintf("TCP %d->%d [%s] seq=%d ack=%d win=%d",
        h.SrcPort, h.DstPort, flags, h.SeqNum, h.AckNum, h.Window)
}
```

### Using binary.Read for Struct Deserialization

```go
package protocols

import (
    "bytes"
    "encoding/binary"
    "fmt"
    "io"
)

// CustomPacketHeader is a binary protocol header using struct tags for byte order.
type CustomPacketHeader struct {
    Magic     uint32  // 4 bytes: protocol magic number
    Version   uint8   // 1 byte: protocol version
    Type      uint8   // 1 byte: message type
    Flags     uint16  // 2 bytes: flags
    Length    uint32  // 4 bytes: payload length
    Sequence  uint32  // 4 bytes: sequence number
    Timestamp int64   // 8 bytes: Unix nanoseconds
    // Total: 24 bytes
}

const (
    ProtocolMagic   = 0x47504354 // "GPCT"
    ProtocolVersion = 1
    MsgTypeData     = 1
    MsgTypeAck      = 2
    MsgTypePing     = 3
    MsgTypePong     = 4
)

// Parse deserializes a packet header from a reader.
// binary.Read respects the machine's byte order specification.
func ParsePacketHeader(r io.Reader) (*CustomPacketHeader, error) {
    var hdr CustomPacketHeader
    // binary.Read fills the struct from the reader using the specified byte order
    if err := binary.Read(r, binary.BigEndian, &hdr); err != nil {
        return nil, fmt.Errorf("read header: %w", err)
    }
    if hdr.Magic != ProtocolMagic {
        return nil, fmt.Errorf("invalid magic: %x (expected %x)", hdr.Magic, ProtocolMagic)
    }
    if hdr.Version != ProtocolVersion {
        return nil, fmt.Errorf("unsupported version: %d", hdr.Version)
    }
    return &hdr, nil
}

// Marshal serializes a packet header to bytes.
func (h *CustomPacketHeader) Marshal() ([]byte, error) {
    var buf bytes.Buffer
    if err := binary.Write(&buf, binary.BigEndian, h); err != nil {
        return nil, fmt.Errorf("write header: %w", err)
    }
    return buf.Bytes(), nil
}
```

## Section 5: Custom UDP Protocol Handler

Let's build a complete custom UDP protocol from scratch: a reliable message delivery protocol over UDP with sequence numbers and acknowledgments.

### Protocol Definition

```
Packet format:
┌────────────────────────────────────────────────────────┐
│ Magic (4)  │ Ver (1) │ Type (1) │ Flags (2)            │
├────────────────────────────────────────────────────────┤
│ Sequence (4) │ AckSeq (4) │ Length (4)                 │
├────────────────────────────────────────────────────────┤
│ Timestamp (8)                                          │
├────────────────────────────────────────────────────────┤
│ Payload (Length bytes)                                 │
└────────────────────────────────────────────────────────┘
Total header: 24 bytes
Max payload: 1440 bytes (to fit in single IP packet without fragmentation)
```

### Server Implementation

```go
package reliableudp

import (
    "bytes"
    "context"
    "encoding/binary"
    "fmt"
    "log"
    "net"
    "sync"
    "time"
)

const (
    MaxPayload     = 1440
    HeaderSize     = 24
    ReadBufferSize = 65536
)

// Packet types
const (
    TypeData    uint8 = 1
    TypeAck     uint8 = 2
    TypeHello   uint8 = 3
    TypeGoodbye uint8 = 4
)

// Packet is a complete protocol message.
type Packet struct {
    Magic     uint32
    Version   uint8
    Type      uint8
    Flags     uint16
    Sequence  uint32
    AckSeq    uint32
    Length    uint32
    Timestamp int64
    Payload   []byte
}

func (p *Packet) Marshal() ([]byte, error) {
    if len(p.Payload) > MaxPayload {
        return nil, fmt.Errorf("payload too large: %d > %d", len(p.Payload), MaxPayload)
    }

    buf := make([]byte, HeaderSize+len(p.Payload))

    binary.BigEndian.PutUint32(buf[0:4], p.Magic)
    buf[4] = p.Version
    buf[5] = p.Type
    binary.BigEndian.PutUint16(buf[6:8], p.Flags)
    binary.BigEndian.PutUint32(buf[8:12], p.Sequence)
    binary.BigEndian.PutUint32(buf[12:16], p.AckSeq)
    binary.BigEndian.PutUint32(buf[16:20], uint32(len(p.Payload)))
    binary.BigEndian.PutUint64(buf[20:28], uint64(p.Timestamp))
    copy(buf[HeaderSize:], p.Payload)

    return buf[:HeaderSize+len(p.Payload)], nil
}

func ParsePacket(data []byte) (*Packet, error) {
    if len(data) < HeaderSize {
        return nil, fmt.Errorf("packet too short: %d bytes", len(data))
    }

    p := &Packet{}
    r := bytes.NewReader(data)

    binary.Read(r, binary.BigEndian, &p.Magic)
    binary.Read(r, binary.BigEndian, &p.Version)
    binary.Read(r, binary.BigEndian, &p.Type)
    binary.Read(r, binary.BigEndian, &p.Flags)
    binary.Read(r, binary.BigEndian, &p.Sequence)
    binary.Read(r, binary.BigEndian, &p.AckSeq)
    binary.Read(r, binary.BigEndian, &p.Length)
    binary.Read(r, binary.BigEndian, &p.Timestamp)

    if p.Magic != 0x47504354 {
        return nil, fmt.Errorf("invalid magic: 0x%x", p.Magic)
    }

    if p.Length > MaxPayload {
        return nil, fmt.Errorf("payload length too large: %d", p.Length)
    }

    if uint32(len(data)) < HeaderSize+p.Length {
        return nil, fmt.Errorf("truncated packet: expected %d bytes, got %d",
            HeaderSize+p.Length, len(data))
    }

    p.Payload = make([]byte, p.Length)
    copy(p.Payload, data[HeaderSize:HeaderSize+p.Length])

    return p, nil
}

// Session represents a client connection.
type Session struct {
    addr      *net.UDPAddr
    lastSeen  time.Time
    recvSeq   uint32 // Next expected sequence number from client
    sendSeq   uint32 // Next sequence number to send
    pendingAck []uint32 // Sequences we need to ack
    mu        sync.Mutex
}

// Server is a UDP server implementing the custom protocol.
type Server struct {
    conn     *net.UDPConn
    sessions map[string]*Session
    mu       sync.RWMutex
    handler  func(session *Session, payload []byte) ([]byte, error)
}

func NewServer(addr string) (*Server, error) {
    udpAddr, err := net.ResolveUDPAddr("udp4", addr)
    if err != nil {
        return nil, fmt.Errorf("resolve: %w", err)
    }

    conn, err := net.ListenUDP("udp4", udpAddr)
    if err != nil {
        return nil, fmt.Errorf("listen: %w", err)
    }

    // Tune UDP buffer sizes for high throughput
    if err := conn.SetReadBuffer(ReadBufferSize * 16); err != nil {
        log.Printf("Warning: could not set read buffer: %v", err)
    }
    if err := conn.SetWriteBuffer(ReadBufferSize * 16); err != nil {
        log.Printf("Warning: could not set write buffer: %v", err)
    }

    return &Server{
        conn:     conn,
        sessions: make(map[string]*Session),
    }, nil
}

func (s *Server) SetHandler(fn func(session *Session, payload []byte) ([]byte, error)) {
    s.handler = fn
}

func (s *Server) Serve(ctx context.Context) error {
    buf := make([]byte, HeaderSize+MaxPayload)

    // Start session cleanup goroutine
    go s.cleanupSessions(ctx)

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        s.conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
        n, addr, err := s.conn.ReadFromUDP(buf)
        if err != nil {
            if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
                continue
            }
            return fmt.Errorf("read: %w", err)
        }

        // Process packet in a goroutine to avoid blocking the receive loop
        data := make([]byte, n)
        copy(data, buf[:n])
        go s.processPacket(addr, data)
    }
}

func (s *Server) processPacket(addr *net.UDPAddr, data []byte) {
    pkt, err := ParsePacket(data)
    if err != nil {
        log.Printf("Invalid packet from %s: %v", addr, err)
        return
    }

    // Get or create session
    sessionKey := addr.String()
    s.mu.Lock()
    session, exists := s.sessions[sessionKey]
    if !exists {
        session = &Session{
            addr:     addr,
            lastSeen: time.Now(),
        }
        s.sessions[sessionKey] = session
    }
    session.lastSeen = time.Now()
    s.mu.Unlock()

    switch pkt.Type {
    case TypeHello:
        s.sendAck(addr, session, pkt.Sequence)

    case TypeData:
        // Check sequence number (simple in-order delivery)
        session.mu.Lock()
        expected := session.recvSeq
        session.mu.Unlock()

        if pkt.Sequence != expected {
            log.Printf("Out-of-order packet from %s: got %d, expected %d",
                addr, pkt.Sequence, expected)
            // Send NAK or request retransmit
            s.sendAck(addr, session, expected-1) // Request retransmit
            return
        }

        // Process payload
        if s.handler != nil {
            response, err := s.handler(session, pkt.Payload)
            if err != nil {
                log.Printf("Handler error for %s: %v", addr, err)
                return
            }

            session.mu.Lock()
            session.recvSeq++
            sendSeq := session.sendSeq
            session.sendSeq++
            session.mu.Unlock()

            // Send response with ack
            respPkt := &Packet{
                Magic:     0x47504354,
                Version:   1,
                Type:      TypeData,
                Sequence:  sendSeq,
                AckSeq:    pkt.Sequence,
                Timestamp: time.Now().UnixNano(),
                Payload:   response,
            }
            s.sendPacket(addr, respPkt)
        } else {
            session.mu.Lock()
            session.recvSeq++
            session.mu.Unlock()
            s.sendAck(addr, session, pkt.Sequence)
        }

    case TypeGoodbye:
        s.mu.Lock()
        delete(s.sessions, sessionKey)
        s.mu.Unlock()
        s.sendAck(addr, session, pkt.Sequence)
    }
}

func (s *Server) sendAck(addr *net.UDPAddr, session *Session, ackSeq uint32) {
    session.mu.Lock()
    sendSeq := session.sendSeq
    session.sendSeq++
    session.mu.Unlock()

    pkt := &Packet{
        Magic:     0x47504354,
        Version:   1,
        Type:      TypeAck,
        Sequence:  sendSeq,
        AckSeq:    ackSeq,
        Timestamp: time.Now().UnixNano(),
    }
    s.sendPacket(addr, pkt)
}

func (s *Server) sendPacket(addr *net.UDPAddr, pkt *Packet) {
    data, err := pkt.Marshal()
    if err != nil {
        log.Printf("Marshal error: %v", err)
        return
    }
    if _, err := s.conn.WriteToUDP(data, addr); err != nil {
        log.Printf("Write error to %s: %v", addr, err)
    }
}

func (s *Server) cleanupSessions(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            cutoff := time.Now().Add(-5 * time.Minute)
            s.mu.Lock()
            for key, session := range s.sessions {
                if session.lastSeen.Before(cutoff) {
                    delete(s.sessions, key)
                }
            }
            s.mu.Unlock()
        }
    }
}

func (s *Server) Close() error {
    return s.conn.Close()
}
```

### Client Implementation

```go
package reliableudp

import (
    "context"
    "fmt"
    "net"
    "sync"
    "sync/atomic"
    "time"
)

// Client is a UDP client implementing the custom protocol.
type Client struct {
    conn       *net.UDPConn
    serverAddr *net.UDPAddr
    sendSeq    atomic.Uint32
    recvSeq    uint32
    mu         sync.Mutex
    pending    map[uint32]chan *Packet
    ctx        context.Context
    cancel     context.CancelFunc
}

func NewClient(serverAddr string) (*Client, error) {
    addr, err := net.ResolveUDPAddr("udp4", serverAddr)
    if err != nil {
        return nil, fmt.Errorf("resolve: %w", err)
    }

    conn, err := net.DialUDP("udp4", nil, addr)
    if err != nil {
        return nil, fmt.Errorf("dial: %w", err)
    }

    ctx, cancel := context.WithCancel(context.Background())
    c := &Client{
        conn:       conn,
        serverAddr: addr,
        pending:    make(map[uint32]chan *Packet),
        ctx:        ctx,
        cancel:     cancel,
    }

    go c.receiveLoop()
    return c, nil
}

func (c *Client) Connect(timeout time.Duration) error {
    seq := c.sendSeq.Add(1) - 1

    helloPkt := &Packet{
        Magic:     0x47504354,
        Version:   1,
        Type:      TypeHello,
        Sequence:  seq,
        Timestamp: time.Now().UnixNano(),
    }

    resultCh := make(chan *Packet, 1)
    c.mu.Lock()
    c.pending[seq] = resultCh
    c.mu.Unlock()

    defer func() {
        c.mu.Lock()
        delete(c.pending, seq)
        c.mu.Unlock()
    }()

    data, _ := helloPkt.Marshal()
    c.conn.Write(data)

    select {
    case <-resultCh:
        return nil
    case <-time.After(timeout):
        return fmt.Errorf("connect timeout")
    case <-c.ctx.Done():
        return c.ctx.Err()
    }
}

// Send sends a payload and waits for acknowledgment.
func (c *Client) Send(ctx context.Context, payload []byte, timeout time.Duration) ([]byte, error) {
    if len(payload) > MaxPayload {
        return nil, fmt.Errorf("payload too large")
    }

    seq := c.sendSeq.Add(1) - 1

    pkt := &Packet{
        Magic:     0x47504354,
        Version:   1,
        Type:      TypeData,
        Sequence:  seq,
        Timestamp: time.Now().UnixNano(),
        Payload:   payload,
    }

    resultCh := make(chan *Packet, 1)
    c.mu.Lock()
    c.pending[seq] = resultCh
    c.mu.Unlock()

    defer func() {
        c.mu.Lock()
        delete(c.pending, seq)
        c.mu.Unlock()
    }()

    data, err := pkt.Marshal()
    if err != nil {
        return nil, err
    }

    // Send with retransmission
    for attempt := 0; attempt < 3; attempt++ {
        if _, err := c.conn.Write(data); err != nil {
            return nil, fmt.Errorf("write: %w", err)
        }

        deadline := time.NewTimer(timeout)
        select {
        case resp := <-resultCh:
            deadline.Stop()
            return resp.Payload, nil
        case <-deadline.C:
            if attempt < 2 {
                continue // Retransmit
            }
            return nil, fmt.Errorf("timeout after %d retransmissions", attempt+1)
        case <-ctx.Done():
            deadline.Stop()
            return nil, ctx.Err()
        }
    }

    return nil, fmt.Errorf("max retransmissions exceeded")
}

func (c *Client) receiveLoop() {
    buf := make([]byte, HeaderSize+MaxPayload)
    for {
        select {
        case <-c.ctx.Done():
            return
        default:
        }

        c.conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
        n, err := c.conn.Read(buf)
        if err != nil {
            if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
                continue
            }
            return
        }

        pkt, err := ParsePacket(buf[:n])
        if err != nil {
            continue
        }

        // Route to pending request
        c.mu.Lock()
        if ch, ok := c.pending[pkt.AckSeq]; ok {
            select {
            case ch <- pkt:
            default:
            }
        }
        c.mu.Unlock()
    }
}

func (c *Client) Close() error {
    c.cancel()

    // Send goodbye
    seq := c.sendSeq.Add(1) - 1
    bye := &Packet{
        Magic:     0x47504354,
        Version:   1,
        Type:      TypeGoodbye,
        Sequence:  seq,
        Timestamp: time.Now().UnixNano(),
    }
    data, _ := bye.Marshal()
    c.conn.Write(data)

    return c.conn.Close()
}
```

### Integration Test

```go
func TestCustomProtocol(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    // Start server
    server, err := NewServer("127.0.0.1:0")
    if err != nil {
        t.Fatal(err)
    }

    echoCount := 0
    server.SetHandler(func(session *Session, payload []byte) ([]byte, error) {
        echoCount++
        return payload, nil
    })

    serverAddr := server.conn.LocalAddr().String()
    go server.Serve(ctx)

    // Create client
    client, err := NewClient(serverAddr)
    if err != nil {
        t.Fatal(err)
    }
    defer client.Close()

    if err := client.Connect(2 * time.Second); err != nil {
        t.Fatal(err)
    }

    // Send messages
    for i := 0; i < 10; i++ {
        msg := fmt.Sprintf("message-%d", i)
        resp, err := client.Send(ctx, []byte(msg), time.Second)
        if err != nil {
            t.Fatalf("Send %d: %v", i, err)
        }
        if string(resp) != msg {
            t.Fatalf("Echo mismatch: got %q, want %q", resp, msg)
        }
    }

    if echoCount != 10 {
        t.Errorf("Expected 10 echo calls, got %d", echoCount)
    }
}
```

## Section 6: Network Performance Tuning

### Zero-Copy Receive with ReadMsgUDP

```go
// High-performance UDP receive using ReadMsgUDP for ancillary data access
func receiveHighPerformance(conn *net.UDPConn) {
    // Pre-allocate OOB buffer for ancillary data (timestamps, TTL, etc.)
    oob := make([]byte, 1024)
    buf := make([]byte, 1500)

    for {
        n, oobn, flags, addr, err := conn.ReadMsgUDP(buf, oob)
        if err != nil {
            break
        }
        // Process without allocating - use buf[:n] directly
        _ = buf[:n]
        _ = oob[:oobn]
        _ = flags
        _ = addr
    }
}
```

### SO_REUSEPORT for Multi-Core UDP

```go
import "golang.org/x/sys/unix"

func listenMulticore(addr string, numWorkers int) ([]*net.UDPConn, error) {
    udpAddr, err := net.ResolveUDPAddr("udp4", addr)
    if err != nil {
        return nil, err
    }

    conns := make([]*net.UDPConn, numWorkers)
    for i := 0; i < numWorkers; i++ {
        // Create socket with SO_REUSEPORT
        fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_NONBLOCK, 0)
        if err != nil {
            return nil, fmt.Errorf("socket: %w", err)
        }

        if err := unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_REUSEPORT, 1); err != nil {
            unix.Close(fd)
            return nil, fmt.Errorf("SO_REUSEPORT: %w", err)
        }

        sa := &unix.SockaddrInet4{Port: udpAddr.Port}
        copy(sa.Addr[:], udpAddr.IP.To4())

        if err := unix.Bind(fd, sa); err != nil {
            unix.Close(fd)
            return nil, fmt.Errorf("bind: %w", err)
        }

        // Wrap in net.UDPConn
        file := os.NewFile(uintptr(fd), "udp")
        conn, err := net.FileConn(file)
        file.Close()
        if err != nil {
            return nil, fmt.Errorf("FileConn: %w", err)
        }
        conns[i] = conn.(*net.UDPConn)
    }

    return conns, nil
}
```

## Summary

Go provides a comprehensive toolkit for network programming from high-level abstractions down to raw socket syscalls. The right level of abstraction depends on the protocol:

- `golang.org/x/net/icmp` is the right choice for ICMP operations - it handles the protocol framing while you focus on the ping/traceroute logic
- Custom binary protocols are best implemented with `encoding/binary` for parsing and `net.UDPConn` for transport; the struct-based approach with `binary.Read/Write` keeps serialization code clean and maintainable
- Raw sockets via `syscall.Socket` are necessary for L3 protocol development or packet injection; the privilege requirements should be addressed with Linux capabilities (`CAP_NET_RAW`) rather than running as root
- High-performance UDP servers benefit from pre-allocated buffers, `ReadMsgUDP` for zero-copy receives, and `SO_REUSEPORT` for multi-core distribution
- The custom UDP protocol example demonstrates a complete request-response pattern with sequence numbers and retransmission - a building block for any reliable-over-UDP system
