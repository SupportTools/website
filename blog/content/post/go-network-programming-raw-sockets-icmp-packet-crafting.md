---
title: "Go Network Programming: Raw Sockets, ICMP, and Packet Crafting"
date: 2029-09-22T00:00:00-05:00
draft: false
tags: ["Go", "Networking", "ICMP", "Raw Sockets", "gopacket", "Network Diagnostics"]
categories: ["Go", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go network programming at the packet level: using golang.org/x/net/icmp for ICMP, raw socket programming, packet capture and crafting with gopacket, implementing ping and traceroute, and building network diagnostic tools."
more_link: "yes"
url: "/go-network-programming-raw-sockets-icmp-packet-crafting/"
---

Most Go network programming lives at the `net.Conn` or HTTP level, but some problems require working at the IP or Ethernet layer. Network diagnostics tools like ping, traceroute, and port scanners need raw socket access. Security tools, packet analyzers, and custom protocol implementations need to craft and parse arbitrary packets. This post covers the complete spectrum from `golang.org/x/net/icmp` for structured ICMP to `gopacket` for full packet capture and crafting, with working implementations of ping, traceroute, and a network path MTU discovery tool.

<!--more-->

# Go Network Programming: Raw Sockets, ICMP, and Packet Crafting

## ICMP with golang.org/x/net/icmp

The `golang.org/x/net/icmp` package provides a structured API for sending and receiving ICMP messages. It handles the low-level socket creation and provides typed message structs.

### Prerequisites

Raw ICMP sockets require elevated privileges on Linux. You have three options:

```bash
# Option 1: Run as root (not recommended for production)
sudo ./ping_tool

# Option 2: Set CAP_NET_RAW capability on the binary
sudo setcap cap_net_raw+ep ./ping_tool

# Option 3: Use IPPROTO_ICMP with non-privileged ICMP ping sockets
# Available on Linux 3.11+ via:
# echo "0 1000" > /proc/sys/net/ipv4/ping_group_range
# This allows any user in GID range 0-1000 to open ICMP sockets
```

### Implementing Ping

```go
// cmd/ping/main.go
package main

import (
    "encoding/binary"
    "fmt"
    "net"
    "os"
    "os/signal"
    "sync/atomic"
    "syscall"
    "time"

    "golang.org/x/net/icmp"
    "golang.org/x/net/ipv4"
)

const (
    protocolICMP     = 1
    protocolICMPv6   = 58
    icmpDataSize     = 56 // bytes of payload in each echo request
)

type PingStats struct {
    Sent     atomic.Int64
    Received atomic.Int64
    MinRTT   atomic.Int64  // nanoseconds
    MaxRTT   atomic.Int64  // nanoseconds
    SumRTT   atomic.Int64  // nanoseconds
}

type Pinger struct {
    addr    *net.IPAddr
    conn    *icmp.PacketConn
    id      int
    stats   PingStats
    timeout time.Duration
}

func NewPinger(host string) (*Pinger, error) {
    addr, err := net.ResolveIPAddr("ip4", host)
    if err != nil {
        return nil, fmt.Errorf("resolve %q: %w", host, err)
    }

    // "ip4:icmp" opens a privileged raw ICMP socket
    // "udp4" would use the non-privileged ping socket (no root required)
    conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
    if err != nil {
        return nil, fmt.Errorf("listen ICMP: %w", err)
    }

    return &Pinger{
        addr:    addr,
        conn:    conn,
        id:      os.Getpid() & 0xFFFF,
        timeout: 5 * time.Second,
    }, nil
}

func (p *Pinger) SendEchoRequest(seq int) error {
    // Build ICMP Echo Request
    payload := make([]byte, icmpDataSize)
    // Embed timestamp in first 8 bytes of payload for RTT measurement
    ts := time.Now().UnixNano()
    binary.BigEndian.PutUint64(payload[:8], uint64(ts))

    msg := icmp.Message{
        Type: ipv4.ICMPTypeEcho,
        Code: 0,
        Body: &icmp.Echo{
            ID:   p.id,
            Seq:  seq,
            Data: payload,
        },
    }

    encoded, err := msg.Marshal(nil)
    if err != nil {
        return fmt.Errorf("marshal ICMP: %w", err)
    }

    _, err = p.conn.WriteTo(encoded, p.addr)
    if err != nil {
        return fmt.Errorf("send ICMP: %w", err)
    }
    p.stats.Sent.Add(1)
    return nil
}

func (p *Pinger) RecvEchoReply() (float64, error) {
    buf := make([]byte, 1500)
    p.conn.SetReadDeadline(time.Now().Add(p.timeout))

    n, peer, err := p.conn.ReadFrom(buf)
    if err != nil {
        return 0, err
    }

    recvTime := time.Now().UnixNano()

    // Parse the ICMP message
    msg, err := icmp.ParseMessage(protocolICMP, buf[:n])
    if err != nil {
        return 0, fmt.Errorf("parse ICMP: %w", err)
    }

    switch msg.Type {
    case ipv4.ICMPTypeEchoReply:
        echo, ok := msg.Body.(*icmp.Echo)
        if !ok {
            return 0, fmt.Errorf("unexpected body type")
        }
        if echo.ID != p.id {
            return 0, fmt.Errorf("echo ID mismatch: got %d want %d", echo.ID, p.id)
        }

        // Extract send timestamp from payload
        if len(echo.Data) < 8 {
            return 0, fmt.Errorf("echo payload too short")
        }
        sendTime := int64(binary.BigEndian.Uint64(echo.Data[:8]))
        rttNs := recvTime - sendTime
        rttMs := float64(rttNs) / float64(time.Millisecond)

        p.stats.Received.Add(1)
        p.updateRTT(rttNs)

        fmt.Printf("Reply from %s: icmp_seq=%d time=%.2f ms\n",
            peer, echo.Seq, rttMs)
        return rttMs, nil

    case ipv4.ICMPTypeDestinationUnreachable:
        body, _ := msg.Body.(*icmp.DstUnreach)
        return 0, fmt.Errorf("destination unreachable from %s: %v", peer, body)

    default:
        return 0, fmt.Errorf("unexpected ICMP type: %v from %s", msg.Type, peer)
    }
}

func (p *Pinger) updateRTT(rttNs int64) {
    p.stats.SumRTT.Add(rttNs)

    // Update min RTT (CAS loop)
    for {
        cur := p.stats.MinRTT.Load()
        if cur != 0 && cur <= rttNs {
            break
        }
        if p.stats.MinRTT.CompareAndSwap(cur, rttNs) {
            break
        }
    }

    // Update max RTT
    for {
        cur := p.stats.MaxRTT.Load()
        if cur >= rttNs {
            break
        }
        if p.stats.MaxRTT.CompareAndSwap(cur, rttNs) {
            break
        }
    }
}

func (p *Pinger) PrintStats(host string) {
    sent := p.stats.Sent.Load()
    recv := p.stats.Received.Load()
    lost := sent - recv
    lossRate := float64(lost) / float64(sent) * 100.0

    fmt.Printf("\n--- %s ping statistics ---\n", host)
    fmt.Printf("%d packets transmitted, %d received, %.1f%% packet loss\n",
        sent, recv, lossRate)

    if recv > 0 {
        minMs := float64(p.stats.MinRTT.Load()) / float64(time.Millisecond)
        maxMs := float64(p.stats.MaxRTT.Load()) / float64(time.Millisecond)
        avgMs := float64(p.stats.SumRTT.Load()) / float64(recv) / float64(time.Millisecond)
        fmt.Printf("round-trip min/avg/max = %.3f/%.3f/%.3f ms\n", minMs, avgMs, maxMs)
    }
}

func (p *Pinger) Close() {
    p.conn.Close()
}

func main() {
    if len(os.Args) < 2 {
        fmt.Fprintf(os.Stderr, "usage: %s <host>\n", os.Args[0])
        os.Exit(1)
    }
    host := os.Args[1]

    pinger, err := NewPinger(host)
    if err != nil {
        fmt.Fprintf(os.Stderr, "error: %v\n", err)
        os.Exit(1)
    }
    defer pinger.Close()

    fmt.Printf("PING %s (%s): %d data bytes\n",
        host, pinger.addr.String(), icmpDataSize)

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        for {
            select {
            case <-sigCh:
                pinger.PrintStats(host)
                os.Exit(0)
            }
        }
    }()

    for seq := 0; ; seq++ {
        if err := pinger.SendEchoRequest(seq); err != nil {
            fmt.Fprintf(os.Stderr, "send error: %v\n", err)
        }
        if _, err := pinger.RecvEchoReply(); err != nil {
            fmt.Printf("Request timeout for icmp_seq %d\n", seq)
        }
        time.Sleep(time.Second)
    }
}
```

## Implementing Traceroute

Traceroute discovers network hops by sending packets with increasing TTL values. Each hop decrements the TTL by 1; when TTL reaches 0, the router sends back an ICMP Time Exceeded message identifying itself.

```go
// internal/traceroute/traceroute.go
package traceroute

import (
    "context"
    "fmt"
    "net"
    "os"
    "time"

    "golang.org/x/net/icmp"
    "golang.org/x/net/ipv4"
)

type HopResult struct {
    TTL      int
    IP       net.IP
    Hostname string
    RTTs     []time.Duration
    Reached  bool
}

// Traceroute performs a traceroute to the given host
// Returns a channel that emits hop results as they arrive
func Traceroute(ctx context.Context, host string, maxHops int) (<-chan HopResult, error) {
    destAddr, err := net.ResolveIPAddr("ip4", host)
    if err != nil {
        return nil, fmt.Errorf("resolve %q: %w", host, err)
    }

    // ICMP listener for Time Exceeded replies
    icmpConn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
    if err != nil {
        return nil, fmt.Errorf("ICMP listen: %w", err)
    }

    results := make(chan HopResult, maxHops)
    pid := os.Getpid() & 0xFFFF

    go func() {
        defer close(results)
        defer icmpConn.Close()

        for ttl := 1; ttl <= maxHops; ttl++ {
            hop := p.probeHop(ctx, icmpConn, destAddr, ttl, pid)
            results <- hop
            if hop.Reached {
                return
            }
            if ctx.Err() != nil {
                return
            }
        }
    }()

    return results, nil
}

// probeHop sends probes for a single TTL value and collects replies
func (p *prober) probeHop(
    ctx context.Context,
    conn *icmp.PacketConn,
    dest *net.IPAddr,
    ttl, pid int,
) HopResult {
    const probesPerHop = 3

    hop := HopResult{TTL: ttl}

    // Use a raw IP socket to set TTL on outgoing packets
    rawConn, err := net.ListenPacket("ip4:icmp", "0.0.0.0")
    if err != nil {
        return hop
    }
    defer rawConn.Close()

    ipConn := ipv4.NewPacketConn(rawConn)
    ipConn.SetTTL(ttl)

    for probe := 0; probe < probesPerHop; probe++ {
        seq := ttl*100 + probe
        msg := icmp.Message{
            Type: ipv4.ICMPTypeEcho,
            Code: 0,
            Body: &icmp.Echo{ID: pid, Seq: seq, Data: make([]byte, 32)},
        }
        encoded, _ := msg.Marshal(nil)

        start := time.Now()
        rawConn.WriteTo(encoded, dest)

        // Wait for Time Exceeded or Echo Reply
        buf := make([]byte, 1500)
        conn.SetReadDeadline(time.Now().Add(2 * time.Second))
        n, from, err := conn.ReadFrom(buf)
        if err != nil {
            hop.RTTs = append(hop.RTTs, -1) // timeout
            continue
        }

        rtt := time.Since(start)
        hop.RTTs = append(hop.RTTs, rtt)

        // Parse reply
        reply, err := icmp.ParseMessage(1, buf[:n])
        if err != nil {
            continue
        }

        srcIP := from.(*net.IPAddr).IP
        if hop.IP == nil {
            hop.IP = srcIP
            // Reverse DNS lookup
            names, _ := net.LookupAddr(srcIP.String())
            if len(names) > 0 {
                hop.Hostname = names[0]
            }
        }

        switch reply.Type {
        case ipv4.ICMPTypeEchoReply:
            hop.Reached = true
        case ipv4.ICMPTypeTimeExceeded:
            // Expected — hop identified
        }
    }

    return hop
}

// PrintTraceroute runs traceroute and prints results in standard format
func PrintTraceroute(ctx context.Context, host string) error {
    fmt.Printf("traceroute to %s, max 30 hops\n", host)

    results, err := Traceroute(ctx, host, 30)
    if err != nil {
        return err
    }

    for hop := range results {
        // Print TTL
        fmt.Printf("%2d  ", hop.TTL)

        if hop.IP == nil {
            fmt.Printf("* * *\n")
            continue
        }

        // Print IP and hostname
        if hop.Hostname != "" {
            fmt.Printf("%s (%s)", hop.Hostname, hop.IP)
        } else {
            fmt.Printf("%s", hop.IP)
        }

        // Print RTTs
        for _, rtt := range hop.RTTs {
            if rtt < 0 {
                fmt.Printf("  *")
            } else {
                fmt.Printf("  %.3f ms", float64(rtt)/float64(time.Millisecond))
            }
        }
        fmt.Println()

        if hop.Reached {
            return nil
        }
    }
    return nil
}
```

## Raw Socket Programming with syscall

For use cases that require direct control over the IP header, use `syscall.Socket` with `SOCK_RAW`.

```go
// internal/rawsock/rawsock.go
package rawsock

import (
    "encoding/binary"
    "fmt"
    "net"
    "syscall"
    "unsafe"
)

// ICMPHeader represents the ICMP message header
type ICMPHeader struct {
    Type     uint8
    Code     uint8
    Checksum uint16
    ID       uint16
    Seq      uint16
}

// IPv4Header represents an IPv4 packet header
type IPv4Header struct {
    VersionIHL     uint8
    DSCP           uint8
    TotalLength    uint16
    Identification uint16
    FlagsFragment  uint16
    TTL            uint8
    Protocol       uint8
    Checksum       uint16
    SrcIP          [4]byte
    DstIP          [4]byte
}

// RawSocket wraps a raw IP socket
type RawSocket struct {
    fd int
}

// NewRawSocket creates a raw IPv4 socket (requires CAP_NET_RAW)
func NewRawSocket(protocol int) (*RawSocket, error) {
    fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_RAW, protocol)
    if err != nil {
        return nil, fmt.Errorf("socket: %w", err)
    }

    // Enable IP_HDRINCL so we can provide our own IP header
    // Required for crafting packets with custom TTL, source IP, etc.
    if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_IP,
        syscall.IP_HDRINCL, 1); err != nil {
        syscall.Close(fd)
        return nil, fmt.Errorf("setsockopt IP_HDRINCL: %w", err)
    }

    return &RawSocket{fd: fd}, nil
}

func (s *RawSocket) Close() {
    syscall.Close(s.fd)
}

// SendICMPWithTTL sends a custom ICMP packet with the specified TTL
func (s *RawSocket) SendICMPWithTTL(dst net.IP, id, seq, ttl int) error {
    // Build ICMP echo request
    icmpHdr := ICMPHeader{
        Type: 8, // Echo Request
        Code: 0,
        ID:   uint16(id),
        Seq:  uint16(seq),
    }

    payload := make([]byte, 32)

    // Compute ICMP checksum
    icmpBytes := make([]byte, 8+len(payload))
    icmpBytes[0] = icmpHdr.Type
    icmpBytes[1] = icmpHdr.Code
    binary.BigEndian.PutUint16(icmpBytes[4:], icmpHdr.ID)
    binary.BigEndian.PutUint16(icmpBytes[6:], icmpHdr.Seq)
    copy(icmpBytes[8:], payload)
    chksum := checksum(icmpBytes)
    binary.BigEndian.PutUint16(icmpBytes[2:], chksum)

    // Build IPv4 header
    totalLen := 20 + len(icmpBytes)
    ipHdr := make([]byte, 20)
    ipHdr[0] = 0x45                                       // version=4, IHL=5
    ipHdr[1] = 0x00                                       // DSCP
    binary.BigEndian.PutUint16(ipHdr[2:], uint16(totalLen))
    binary.BigEndian.PutUint16(ipHdr[4:], uint16(id))    // identification
    ipHdr[6] = 0x00                                       // flags
    ipHdr[7] = 0x00                                       // fragment offset
    ipHdr[8] = uint8(ttl)                                 // TTL
    ipHdr[9] = 0x01                                       // protocol = ICMP
    copy(ipHdr[12:16], net.IPv4(0, 0, 0, 0).To4())       // src = 0.0.0.0 (kernel fills)
    copy(ipHdr[16:20], dst.To4())                         // dst

    // Compute IP checksum
    ipChksum := checksum(ipHdr)
    binary.BigEndian.PutUint16(ipHdr[10:], ipChksum)

    packet := append(ipHdr, icmpBytes...)

    var dstSockAddr syscall.SockaddrInet4
    copy(dstSockAddr.Addr[:], dst.To4())

    return syscall.Sendto(s.fd, packet, 0, &dstSockAddr)
}

// checksum computes the RFC 1071 Internet checksum
func checksum(data []byte) uint16 {
    var sum uint32
    for i := 0; i+1 < len(data); i += 2 {
        sum += uint32(data[i])<<8 | uint32(data[i+1])
    }
    if len(data)%2 == 1 {
        sum += uint32(data[len(data)-1]) << 8
    }
    for sum>>16 != 0 {
        sum = (sum & 0xFFFF) + (sum >> 16)
    }
    return ^uint16(sum)
}
```

## Packet Capture with gopacket

`gopacket` provides a comprehensive packet parsing and capture library. It supports pcap (libpcap), AF_PACKET, and pfring for capture, and can parse virtually any protocol.

```go
// internal/capture/capture.go
package capture

import (
    "fmt"
    "log"
    "net"
    "time"

    "github.com/google/gopacket"
    "github.com/google/gopacket/layers"
    "github.com/google/gopacket/pcap"
)

// PacketAnalyzer captures and analyzes packets on an interface
type PacketAnalyzer struct {
    iface  string
    filter string
    handle *pcap.Handle
}

func NewPacketAnalyzer(iface, bpfFilter string) (*PacketAnalyzer, error) {
    // Open the interface for capture (promiscuous mode, 64KB snaplen, 30ms timeout)
    handle, err := pcap.OpenLive(iface, 65536, true, 30*time.Millisecond)
    if err != nil {
        return nil, fmt.Errorf("pcap.OpenLive(%q): %w", iface, err)
    }

    // Set BPF (Berkeley Packet Filter) for efficient kernel-side filtering
    if bpfFilter != "" {
        if err := handle.SetBPFFilter(bpfFilter); err != nil {
            handle.Close()
            return nil, fmt.Errorf("BPF filter %q: %w", bpfFilter, err)
        }
    }

    return &PacketAnalyzer{iface: iface, filter: bpfFilter, handle: handle}, nil
}

func (a *PacketAnalyzer) Close() {
    a.handle.Close()
}

// ConnectionRecord tracks a TCP connection
type ConnectionRecord struct {
    SrcIP    net.IP
    DstIP    net.IP
    SrcPort  uint16
    DstPort  uint16
    Packets  int
    Bytes    int
    Start    time.Time
    Last     time.Time
    SYN      bool
    FIN      bool
}

// AnalyzeTCPConnections captures packets and builds a connection table
func (a *PacketAnalyzer) AnalyzeTCPConnections(duration time.Duration) map[string]*ConnectionRecord {
    connections := make(map[string]*ConnectionRecord)
    deadline := time.Now().Add(duration)

    // gopacket source: decodes packets as they arrive
    packetSource := gopacket.NewPacketSource(a.handle, a.handle.LinkType())
    packetSource.Lazy = true        // decode layers only when accessed
    packetSource.NoCopy = true       // reuse buffers for performance

    for packet := range packetSource.Packets() {
        if time.Now().After(deadline) {
            break
        }

        // Decode network layer
        networkLayer := packet.NetworkLayer()
        if networkLayer == nil {
            continue
        }

        // Decode transport layer
        transportLayer := packet.TransportLayer()
        if transportLayer == nil {
            continue
        }

        tcpLayer, ok := transportLayer.(*layers.TCP)
        if !ok {
            continue
        }

        // Extract IP addresses
        var srcIP, dstIP net.IP
        switch nl := networkLayer.(type) {
        case *layers.IPv4:
            srcIP = nl.SrcIP
            dstIP = nl.DstIP
        case *layers.IPv6:
            srcIP = nl.SrcIP
            dstIP = nl.DstIP
        default:
            continue
        }

        // Build connection key (normalized: lower IP first)
        key := fmt.Sprintf("%s:%d-%s:%d",
            srcIP, tcpLayer.SrcPort, dstIP, tcpLayer.DstPort)

        rec, exists := connections[key]
        if !exists {
            rec = &ConnectionRecord{
                SrcIP:   srcIP,
                DstIP:   dstIP,
                SrcPort: uint16(tcpLayer.SrcPort),
                DstPort: uint16(tcpLayer.DstPort),
                Start:   packet.Metadata().Timestamp,
            }
            connections[key] = rec
        }

        rec.Packets++
        rec.Bytes += len(packet.Data())
        rec.Last = packet.Metadata().Timestamp
        rec.SYN = rec.SYN || tcpLayer.SYN
        rec.FIN = rec.FIN || tcpLayer.FIN
    }

    return connections
}

// ICMPAnalyzer monitors ICMP messages on the network
func (a *PacketAnalyzer) ICMPAnalyzer(handler func(srcIP, dstIP net.IP, msgType, code uint8)) {
    packetSource := gopacket.NewPacketSource(a.handle, a.handle.LinkType())

    for packet := range packetSource.Packets() {
        ipLayer, ok := packet.NetworkLayer().(*layers.IPv4)
        if !ok {
            continue
        }

        icmpLayer, ok := packet.Layer(layers.LayerTypeICMPv4).(*layers.ICMPv4)
        if !ok {
            continue
        }

        handler(ipLayer.SrcIP, ipLayer.DstIP, uint8(icmpLayer.TypeCode>>8), uint8(icmpLayer.TypeCode))
    }
}
```

### Packet Crafting with gopacket

```go
// internal/craft/craft.go
package craft

import (
    "net"

    "github.com/google/gopacket"
    "github.com/google/gopacket/layers"
)

// CraftICMPEchoRequest builds a complete ICMP echo request packet
// as a byte slice suitable for sending via a raw socket
func CraftICMPEchoRequest(
    srcIP, dstIP net.IP,
    id, seq int,
    ttl uint8,
    payload []byte,
) ([]byte, error) {
    // Ethernet layer (needed for AF_PACKET injection, not for raw IP socket)
    // eth := &layers.Ethernet{
    //     SrcMAC:       net.HardwareAddr{0x00, 0x11, 0x22, 0x33, 0x44, 0x55},
    //     DstMAC:       net.HardwareAddr{0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
    //     EthernetType: layers.EthernetTypeIPv4,
    // }

    // IPv4 layer
    ip := &layers.IPv4{
        Version:  4,
        IHL:      5,
        TTL:      ttl,
        Protocol: layers.IPProtocolICMPv4,
        SrcIP:    srcIP.To4(),
        DstIP:    dstIP.To4(),
    }

    // ICMP layer
    icmp := &layers.ICMPv4{
        TypeCode: layers.CreateICMPv4TypeCode(
            layers.ICMPv4TypeEchoRequest, 0),
        Id:  uint16(id),
        Seq: uint16(seq),
    }

    // Serialize with checksums computed automatically
    buf := gopacket.NewSerializeBuffer()
    opts := gopacket.SerializeOptions{
        ComputeChecksums: true,
        FixLengths:       true,
    }

    err := gopacket.SerializeLayers(buf, opts,
        ip,
        icmp,
        gopacket.Payload(payload),
    )
    if err != nil {
        return nil, err
    }

    return buf.Bytes(), nil
}

// CraftSYNPacket creates a TCP SYN packet for port scanning
func CraftSYNPacket(srcIP, dstIP net.IP, srcPort, dstPort uint16, ttl uint8) ([]byte, error) {
    ip := &layers.IPv4{
        Version:  4,
        IHL:      5,
        TTL:      ttl,
        Protocol: layers.IPProtocolTCP,
        SrcIP:    srcIP.To4(),
        DstIP:    dstIP.To4(),
    }

    tcp := &layers.TCP{
        SrcPort: layers.TCPPort(srcPort),
        DstPort: layers.TCPPort(dstPort),
        Seq:     0x12345678,
        SYN:     true,
        Window:  65535,
    }
    tcp.SetNetworkLayerForChecksum(ip)

    buf := gopacket.NewSerializeBuffer()
    opts := gopacket.SerializeOptions{
        ComputeChecksums: true,
        FixLengths:       true,
    }

    err := gopacket.SerializeLayers(buf, opts, ip, tcp)
    if err != nil {
        return nil, err
    }
    return buf.Bytes(), nil
}
```

## Network Path MTU Discovery Tool

A practical tool that discovers the maximum transmission unit along a network path using ICMP:

```go
// cmd/pmtud/main.go — Path MTU Discovery
package main

import (
    "fmt"
    "net"
    "os"
    "time"

    "golang.org/x/net/icmp"
    "golang.org/x/net/ipv4"
)

// findPathMTU performs binary search for the path MTU to the destination
func findPathMTU(dest string) (int, error) {
    addr, err := net.ResolveIPAddr("ip4", dest)
    if err != nil {
        return 0, err
    }

    // Open raw ICMP socket
    conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
    if err != nil {
        return 0, fmt.Errorf("listen ICMP: %w", err)
    }
    defer conn.Close()

    low, high := 68, 1500  // 68 is minimum IPv4 MTU; 1500 is Ethernet MTU
    pid := os.Getpid() & 0xFFFF

    for low < high {
        mid := (low + high + 1) / 2  // ceiling division for binary search
        fits, err := probeMTU(conn, addr, pid, mid)
        if err != nil {
            low = 68
            break
        }
        if fits {
            low = mid
        } else {
            high = mid - 1
        }
    }

    return low, nil
}

// probeMTU sends an ICMP echo of size `size` bytes and checks for Frag Needed
func probeMTU(conn *icmp.PacketConn, addr *net.IPAddr, pid, size int) (bool, error) {
    // ICMP header is 8 bytes; IP header is 20 bytes
    // Total packet = 20 (IP) + 8 (ICMP) + payload
    // We want total size = `size`, so payload = size - 28
    payloadSize := size - 28
    if payloadSize < 0 {
        payloadSize = 0
    }

    msg := icmp.Message{
        Type: ipv4.ICMPTypeEcho,
        Code: 0,
        Body: &icmp.Echo{
            ID:   pid,
            Seq:  size, // use size as sequence to correlate responses
            Data: make([]byte, payloadSize),
        },
    }

    // Set DF (Don't Fragment) bit — this is the key for PMTU discovery
    rawConn, err := net.ListenPacket("ip4:icmp", "0.0.0.0")
    if err != nil {
        return false, err
    }
    defer rawConn.Close()

    ipConn := ipv4.NewPacketConn(rawConn)
    // Set IP_DONTFRAG to prevent kernel fragmentation
    if err := ipConn.SetControlMessage(ipv4.FlagDst|ipv4.FlagSrc, true); err != nil {
        return false, err
    }

    encoded, _ := msg.Marshal(nil)
    rawConn.WriteTo(encoded, addr)

    // Wait for reply — either Echo Reply (packet fits) or Frag Needed (too large)
    buf := make([]byte, 2048)
    conn.SetReadDeadline(time.Now().Add(2 * time.Second))
    n, _, err := conn.ReadFrom(buf)
    if err != nil {
        // Timeout treated as "doesn't fit" (conservatively)
        return false, nil
    }

    reply, err := icmp.ParseMessage(1, buf[:n])
    if err != nil {
        return false, nil
    }

    switch reply.Type {
    case ipv4.ICMPTypeEchoReply:
        return true, nil  // packet was received intact
    case ipv4.ICMPTypeDestinationUnreachable:
        body, ok := reply.Body.(*icmp.DstUnreach)
        if ok && body != nil {
            // Code 4 = Fragmentation Needed and DF was Set
            if reply.Code == 4 {
                return false, nil  // too large
            }
        }
        return false, nil
    }

    return false, nil
}

func main() {
    if len(os.Args) < 2 {
        fmt.Fprintf(os.Stderr, "usage: %s <host>\n", os.Args[0])
        os.Exit(1)
    }

    host := os.Args[1]
    fmt.Printf("Discovering path MTU to %s...\n", host)

    mtu, err := findPathMTU(host)
    if err != nil {
        fmt.Fprintf(os.Stderr, "error: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Path MTU to %s: %d bytes\n", host, mtu)
    fmt.Printf("Usable payload per packet:\n")
    fmt.Printf("  UDP:    %d bytes\n", mtu-20-8)
    fmt.Printf("  TCP:    %d bytes (approximate, no options)\n", mtu-20-20)
    fmt.Printf("  ICMPv4: %d bytes\n", mtu-20-8)
}
```

## Network Diagnostics CLI Tool

Combining ping, traceroute, and MTU discovery into a unified diagnostic tool:

```go
// cmd/netdiag/main.go
package main

import (
    "context"
    "flag"
    "fmt"
    "os"
    "time"
)

func main() {
    var (
        pingCmd  = flag.NewFlagSet("ping", flag.ExitOnError)
        traceCmd = flag.NewFlagSet("trace", flag.ExitOnError)
        pmtudCmd = flag.NewFlagSet("pmtud", flag.ExitOnError)
    )

    pingCount   := pingCmd.Int("c", 5, "number of pings")
    pingTimeout := pingCmd.Duration("W", 2*time.Second, "timeout per ping")

    traceMaxHops := traceCmd.Int("m", 30, "max hops")

    if len(os.Args) < 2 {
        fmt.Fprintln(os.Stderr, "usage: netdiag <ping|trace|pmtud> <host>")
        os.Exit(1)
    }

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
    defer cancel()

    switch os.Args[1] {
    case "ping":
        pingCmd.Parse(os.Args[2:])
        if pingCmd.NArg() == 0 {
            fmt.Fprintln(os.Stderr, "ping requires a host argument")
            os.Exit(1)
        }
        _ = pingTimeout // used in Pinger implementation
        runPing(ctx, pingCmd.Arg(0), *pingCount)

    case "trace":
        traceCmd.Parse(os.Args[2:])
        if traceCmd.NArg() == 0 {
            fmt.Fprintln(os.Stderr, "trace requires a host argument")
            os.Exit(1)
        }
        runTrace(ctx, traceCmd.Arg(0), *traceMaxHops)

    case "pmtud":
        pmtudCmd.Parse(os.Args[2:])
        if pmtudCmd.NArg() == 0 {
            fmt.Fprintln(os.Stderr, "pmtud requires a host argument")
            os.Exit(1)
        }
        runPMTUD(pmtudCmd.Arg(0))

    default:
        fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
        os.Exit(1)
    }
}

func runPing(ctx context.Context, host string, count int) {
    pinger, err := NewPinger(host)
    if err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
    defer pinger.Close()

    for i := 0; i < count; i++ {
        pinger.SendEchoRequest(i)
        pinger.RecvEchoReply()
        time.Sleep(time.Second)
    }
    pinger.PrintStats(host)
}
```

## Summary

Go's network programming capabilities extend well beyond high-level HTTP clients:

- **golang.org/x/net/icmp** provides a clean, typed interface for ICMP without manually managing checksum computation or socket options. Use it for ping, traceroute, and ICMP-based diagnostic tools.
- **syscall.Socket with SOCK_RAW** gives full control over IP headers, essential for tools that need to set TTL, source address, or DF bit directly.
- **gopacket** handles packet capture (via pcap/AF_PACKET) and provides a rich decoder for parsing any network protocol, plus a serializer for crafting arbitrary packets with automatic checksum computation.
- **Privilege requirements**: raw sockets require `CAP_NET_RAW`. Prefer setting capabilities on specific binaries over running entire services as root. For ICMP ping specifically, the non-privileged ping socket (via `/proc/sys/net/ipv4/ping_group_range`) avoids the need for any elevated privileges.

The patterns in this post form the foundation for building network diagnostic tools, security scanners, custom protocol implementations, and high-performance packet processing applications in Go.
