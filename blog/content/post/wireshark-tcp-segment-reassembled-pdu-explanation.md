---
title: "Wireshark \"TCP Segment of a Reassembled PDU\" Explained"
date: 2023-10-13T12:15:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Wireshark", "TCP", "Network Analysis", "Network Tools"]
categories:
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "\"TCP segment of a reassembled PDU\" is not an error: the packet carries part of a larger HTTP or TLS message. What it means and how to turn it off."
more_link: "yes"
quick_fix: |
  It is not an error. The packet holds part of an application message (an HTTP response, a TLS record) that Wireshark decodes on the last packet of that message.
  To see each packet decoded on its own, uncheck Edit > Preferences > Protocols > TCP > "Allow subdissector to reassemble TCP streams", or run `tshark -o tcp.desegment_tcp_streams:FALSE`.
---

## Understanding 'TCP Segment of a Reassembled PDU' in Wireshark

Wireshark often marks TCP packets with the label "TCP segment of a reassembled PDU." It looks like a warning, but it is normal: the packet contains part of a longer application message or document, and Wireshark assembles the complete message across multiple packets before it decodes it.

<!--more-->

## Why TCP Splits Application Messages

Distributed applications communicate using TCP sockets, treating data as a continuous stream of bytes. TCP segments this data into IP packets for network transport. TCP's segmentation happens independently of application message or document boundaries, resulting in scenarios where:

- Multiple application messages are sent in a single network packet due to buffering while awaiting acknowledgments.
- An application sends a document larger than a single packet can carry (for example an HTTP response or a TLS certificate chain bigger than the MSS of about 1460 bytes).

Consequently, TCP's byte-stream model allows for one-to-many and many-to-one relationships between messages and packets.

## How Wireshark Reassembles the Stream

Wireshark shows two levels at once: individual packets, and application messages parsed by protocol dissectors (HTTP, TLS, SMB and so on). The dissectors rely on Wireshark's TCP reassembly. For each direction of a TCP connection, Wireshark collects the payload from all packets, orders it by sequence number, and concatenates it to rebuild the byte stream. The dissector then looks for application messages in that stream. If the sender's TCP stack split a message across several packets, the dissector waits until the packet that completes the message before it decodes and displays the content.

As a result, the dissector shows nothing for the earlier packets that carry an incomplete payload. To tell you why, Wireshark marks each of them with "TCP segment of a reassembled PDU," where:

- "Segment" is a chunk of payload with its TCP header. It is close to "packet," but not the same thing (a large TCP segment can be split into several IP fragments).
- "PDU" stands for "Protocol Data Unit," the application message or document as decoded by a Wireshark dissector.

When the final packet arrives, Wireshark shows the full dissection on that packet, plus a "Reassembled TCP" tab in the packet bytes pane with the payload of all the packets that made up the message.

## When It Is a Problem

The label on its own never means packet loss or a broken connection. Look further only if you also see:

- `[TCP Previous segment not captured]` or `[TCP ACKed unseen segment]`: the capture missed packets, so Wireshark cannot finish the reassembly and the message is never decoded.
- `[TCP Retransmission]` or `[TCP Dup ACK]`: real loss on the network.
- The message never completes: the connection closed or the capture stopped before the last segment.

## How to Turn Reassembly Off or Follow the Data

- **See each packet decoded separately:** Edit > Preferences > Protocols > TCP, uncheck "Allow subdissector to reassemble TCP streams". The label disappears, but large messages are no longer decoded as a whole. With tshark, pass `-o tcp.desegment_tcp_streams:FALSE`.
- **Find the packet that completes the message:** open the TCP layer of a marked packet in the packet details pane; it links to the frame where the PDU was reassembled. The `tcp.reassembled_in` field holds that frame number, so the display filter `tcp.reassembled_in` lists every segment that is part of a reassembled message.
- **Read the whole conversation:** right-click the packet and choose Follow > TCP Stream to see the reassembled bytes of both directions.

## FAQ

### Does "TCP segment of a reassembled PDU" mean packets are being dropped?

No. It only says the packet holds part of a larger message. Drops show up as retransmissions, duplicate ACKs or "previous segment not captured".

### Why do I see it mostly on HTTPS or large HTTP responses?

Those messages are usually bigger than one TCP segment. A TLS handshake that carries a certificate chain, or any HTTP response larger than about 1460 bytes, has to span several packets.

### Why does the HTTP response show up on the last packet only?

That is the packet where Wireshark has the complete message, so the HTTP dissector runs there. The earlier packets are the pieces it was waiting for.

## Related Guides

- [How to Use tcpdump to Capture Incoming Traffic](/post/using-tcpdump-capture-incoming-traffic-guide/)
- [Network Packet Capture in Kubernetes](/kubernetes-network-packet-capture-analysis-guide/)
- [How to Filter MAC Addresses Using tcpdump](/post/filtering-mac-addresses-tcpdump-guide/)
- [Using ping to Find the Correct MTU on Linux](/ping-mtu-linux/)
