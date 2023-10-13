---
title: "Understanding 'TCP Segment of a Reassembled PDU' in Wireshark"
date: 2023-10-13T12:15:00-05:00
draft: false
tags: ["Wireshark", "TCP", "Network Analysis"]
categories:
- Network Tools
- Network Analysis
author: "Matthew Mattox - mmattox@support.tools."
description: "An explanation of why Wireshark marks TCP packets with 'TCP segment of a reassembled PDU.'"
more_link: "yes"
---

## Understanding 'TCP Segment of a Reassembled PDU' in Wireshark

Wireshark often marks TCP packets with the label "TCP segment of a reassembled PDU." This annotation can seem perplexing but serves a crucial purpose in network analysis. Let's delve into why Wireshark uses this label and what it signifies.

In essence, Wireshark uses the "TCP segment of a reassembled PDU" label when a packet contains part of a longer application message or document, and the complete message or document is assembled across multiple packets.

To comprehend this, it's necessary to explore the inner workings of TCP. Distributed applications communicate using TCP sockets, treating data as a continuous stream of bytes. TCP segments this data into IP packets for network transport. However, TCP's segmentation occurs independently of application message or document boundaries, resulting in scenarios where:

- Multiple application messages are sent in a single network packet due to buffering while awaiting acknowledgments.
- An application sends a document larger than a single packet can accommodate.

Consequently, TCP's byte-stream model allows for one-to-many and many-to-one relationships between messages and packets.

Wireshark provides a dual-level view of network packet captures: it primarily displays individual packets and parses application messages through plugins. These plugins rely on Wireshark's TCP reassembly, where, for each direction of a TCP connection, it accumulates payload from all packets, orders them by sequence number, and concatenates them to reconstruct the byte stream. The dissector then examines this stream for application messages and documents. Suppose the original TCP stack fragmented a message or document across multiple packets. In that case, the dissector waits until Wireshark processes the final packet with the complete application payload before dissecting and displaying the content.

As a result, the dissector does not display anything for the initial packets carrying the incomplete payload. To alert users to this situation, Wireshark marks each of these packets with "TCP segment of a reassembled PDU," where:

- "Segment" corresponds to a chunk of payload with the associated TCP header. While synonymous with "packet," it technically differs (e.g., large TCP segments can get fragmented into multiple IP packets).
- "PDU" stands for "Protocol Data Unit" and signifies an application message or document as dissected by a Wireshark plugin.

Once the final packet arrives with the complete payload, Wireshark displays the entire dissection of that packet and shows the raw payload bytes from all constituent packets.

In summary, Wireshark uses the "TCP segment of a reassembled PDU" label when a packet contains part of a longer application message or document, and the complete message or document is assembled across multiple packets. This label is a valuable indicator in network analysis, helping analysts understand data flow in complex network communications.
