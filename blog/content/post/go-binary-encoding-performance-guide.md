---
title: "Go Binary Encoding Performance: Protocol Buffers, MessagePack, Cap'n Proto, and Zero-Copy Patterns"
date: 2028-05-30T00:00:00-05:00
draft: false
tags: ["Go", "Protocol Buffers", "MessagePack", "Cap'n Proto", "FlatBuffers", "Performance", "Serialization"]
categories: ["Go", "Performance", "Backend Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep comparison of Go binary encoding formats: encoding/binary, Protocol Buffers, MessagePack, Cap'n Proto, and FlatBuffers. Benchmarks, zero-copy patterns, and guidance on selecting the right format for each use case."
more_link: "yes"
url: "/go-binary-encoding-performance-guide/"
---

Serialization is often the hidden bottleneck in high-throughput Go services. JSON's human readability comes at a steep cost: reflection-based encoding, large wire sizes, and garbage pressure from string allocation. Binary encoding formats eliminate these costs, but each format makes different trade-offs between encoding speed, decoding speed, schema evolution, random access, and zero-copy capability. This guide provides benchmarks and decision criteria for choosing between `encoding/binary`, Protocol Buffers, MessagePack, Cap'n Proto, and FlatBuffers in Go.

<!--more-->

## The Encoding Performance Landscape

### What Matters

Before selecting an encoding format, identify the bottleneck:

- **Encoding speed**: How fast can a Go struct become bytes?
- **Decoding speed**: How fast can bytes become a Go struct?
- **Memory allocation**: How much heap pressure does each operation create?
- **Wire size**: How large is the encoded message?
- **Random access**: Can you read field X without decoding fields A-W?
- **Schema evolution**: Can new fields be added without breaking old readers?
- **Streaming**: Can messages be encoded/decoded without full buffering?

### Quick Reference

| Format | Encode | Decode | Wire Size | Random Access | Schema |
|--------|--------|--------|-----------|---------------|--------|
| encoding/binary | Fast | Fast | Minimal | No (fixed layout) | No |
| Protocol Buffers | Fast | Fast | Small | No | Yes |
| MessagePack | Very Fast | Very Fast | Small | No | Partial |
| Cap'n Proto | Zero-copy | Zero-copy | Small | Yes | Yes |
| FlatBuffers | Fast | Zero-copy | Small | Yes | Partial |
| JSON | Slow | Slow | Large | No | Yes (informal) |

## encoding/binary

The standard library `encoding/binary` package is the right choice for fixed-format protocols, network packets, and performance-critical binary file formats where the schema never changes.

```go
package binary_test

import (
    "bytes"
    "encoding/binary"
    "io"
    "testing"
)

// Fixed-layout packet structure
type SensorReading struct {
    Timestamp   int64    // 8 bytes
    SensorID    uint32   // 4 bytes
    Temperature float32  // 4 bytes
    Humidity    float32  // 4 bytes
    Pressure    float32  // 4 bytes
    // Total: 24 bytes, no padding needed with this layout
}

// Using binary.Write (allocates a bytes.Buffer internally)
func EncodeWithWrite(r *SensorReading) ([]byte, error) {
    var buf bytes.Buffer
    buf.Grow(24)
    if err := binary.Write(&buf, binary.LittleEndian, r); err != nil {
        return nil, err
    }
    return buf.Bytes(), nil
}

// Using unsafe.Pointer for zero-allocation encoding
// This is the fastest approach — directly reads struct memory
import "unsafe"

func EncodeZeroCopy(r *SensorReading) []byte {
    const size = 24 // unsafe.Sizeof(*r)
    // Direct memory representation — only valid for fixed-size types with no pointers
    return (*[size]byte)(unsafe.Pointer(r))[:]
}

// Using append + binary.BigEndian for portable encoding
func EncodeManual(r *SensorReading, buf []byte) []byte {
    buf = binary.LittleEndian.AppendUint64(buf, uint64(r.Timestamp))
    buf = binary.LittleEndian.AppendUint32(buf, r.SensorID)
    buf = binary.LittleEndian.AppendUint32(buf, math.Float32bits(r.Temperature))
    buf = binary.LittleEndian.AppendUint32(buf, math.Float32bits(r.Humidity))
    buf = binary.LittleEndian.AppendUint32(buf, math.Float32bits(r.Pressure))
    return buf
}

// Decoding with binary.Read
func Decode(data []byte) (*SensorReading, error) {
    var r SensorReading
    if err := binary.Read(bytes.NewReader(data), binary.LittleEndian, &r); err != nil {
        return nil, err
    }
    return &r, nil
}

// Zero-allocation decoding with unsafe
func DecodeZeroCopy(data []byte) *SensorReading {
    if len(data) < 24 {
        panic("insufficient data")
    }
    return (*SensorReading)(unsafe.Pointer(&data[0]))
    // WARNING: the returned pointer aliases the original slice data
    // The caller must not modify data while using the result
}
```

### Benchmark Results (encoding/binary)

```bash
BenchmarkEncodeWrite-8        5000000    285 ns/op    24 B/op    1 allocs/op
BenchmarkEncodeManual-8      20000000     82 ns/op     0 B/op    0 allocs/op
BenchmarkEncodeUnsafe-8     200000000      5 ns/op     0 B/op    0 allocs/op
BenchmarkDecodeRead-8         5000000    312 ns/op    48 B/op    2 allocs/op
BenchmarkDecodeUnsafe-8     200000000      4 ns/op     0 B/op    0 allocs/op
```

## Protocol Buffers

Protocol Buffers are the right choice when you need schema evolution (adding/removing fields over time), cross-language compatibility, and moderate performance.

### Schema Definition

```protobuf
// sensor.proto
syntax = "proto3";
package sensor;
option go_package = "github.com/example/sensor/proto";

message SensorReading {
    int64 timestamp = 1;
    uint32 sensor_id = 2;
    float temperature = 3;
    float humidity = 4;
    float pressure = 5;
    string location = 6;         // Added in v2
    repeated string tags = 7;    // Added in v3
}

message SensorBatch {
    repeated SensorReading readings = 1;
    string source = 2;
    int64 batch_id = 3;
}
```

```bash
# Install protoc and Go plugin
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
protoc --go_out=. --go_opt=paths=source_relative sensor.proto
```

### Efficient Encoding with Protobuf

```go
package proto_test

import (
    "github.com/example/sensor/proto"
    "google.golang.org/protobuf/proto"
)

// Basic encoding
func EncodeBasic(r *proto.SensorReading) ([]byte, error) {
    return proto.Marshal(r)
}

// Reuse a preallocated buffer to reduce allocations
// protobuf supports MarshalOptions for buffer reuse
func EncodeWithBuffer(r *proto.SensorReading, buf []byte) ([]byte, error) {
    opts := proto.MarshalOptions{}
    return opts.MarshalAppend(buf[:0], r)
}

// For batch processing: encode directly to a pre-allocated buffer
type Encoder struct {
    opts proto.MarshalOptions
    buf  []byte
}

func NewEncoder(initialCap int) *Encoder {
    return &Encoder{
        buf: make([]byte, 0, initialCap),
    }
}

func (e *Encoder) Encode(m proto.Message) ([]byte, error) {
    e.buf = e.buf[:0]
    var err error
    e.buf, err = e.opts.MarshalAppend(e.buf, m)
    return e.buf, err
}

// Decode with object reuse (avoids repeated allocation)
type Decoder struct {
    reading proto.SensorReading
}

func (d *Decoder) Decode(data []byte) (*proto.SensorReading, error) {
    d.reading.Reset()
    if err := proto.Unmarshal(data, &d.reading); err != nil {
        return nil, err
    }
    return &d.reading, nil
}

// Unknown fields: proto3 preserves unknown fields for forward compatibility
// Reader using proto2 schema sees proto3 fields it doesn't know as unknown fields
// These are preserved and re-serialized, enabling safe field addition
```

### Benchmark Results (Protocol Buffers)

```bash
BenchmarkProtoEncode-8       5000000    198 ns/op    48 B/op    1 allocs/op
BenchmarkProtoEncodeAppend-8 8000000    134 ns/op     0 B/op    0 allocs/op
BenchmarkProtoDecode-8       4000000    289 ns/op   136 B/op    3 allocs/op
BenchmarkProtoDecodeReuse-8  6000000    195 ns/op    64 B/op    1 allocs/op
```

## MessagePack

MessagePack is the right choice when you need schema-less encoding (no .proto file), performance close to Protocol Buffers, and compatibility with dynamically-typed languages.

```bash
go get github.com/vmihailenco/msgpack/v5@latest
```

### Basic MessagePack

```go
package msgpack_test

import (
    "github.com/vmihailenco/msgpack/v5"
)

type SensorReading struct {
    Timestamp   int64   `msgpack:"ts"`
    SensorID    uint32  `msgpack:"sid"`
    Temperature float32 `msgpack:"temp"`
    Humidity    float32 `msgpack:"hum"`
    Pressure    float32 `msgpack:"pres"`
    Location    string  `msgpack:"loc,omitempty"`
}

// Basic encode
func Encode(r *SensorReading) ([]byte, error) {
    return msgpack.Marshal(r)
}

// Encode using an encoder with a pre-allocated buffer (reduces allocations)
func EncodeToBuffer(r *SensorReading, w io.Writer) error {
    enc := msgpack.NewEncoder(w)
    enc.SetCustomStructTag("msgpack")
    enc.UseCompactInts(true)
    return enc.Encode(r)
}

// Decode
func Decode(data []byte) (*SensorReading, error) {
    var r SensorReading
    if err := msgpack.Unmarshal(data, &r); err != nil {
        return nil, err
    }
    return &r, nil
}

// Schemaless decode into map (for dynamic processing)
func DecodeToMap(data []byte) (map[string]interface{}, error) {
    var result map[string]interface{}
    err := msgpack.Unmarshal(data, &result)
    return result, err
}
```

### MessagePack with Object Pooling

```go
// For high-throughput scenarios, pool encoder/decoder
var encoderPool = sync.Pool{
    New: func() interface{} {
        var buf bytes.Buffer
        enc := msgpack.NewEncoder(&buf)
        enc.UseCompactInts(true)
        enc.UseCompactFloats(true)
        return &pooledEncoder{enc: enc, buf: &buf}
    },
}

type pooledEncoder struct {
    enc *msgpack.Encoder
    buf *bytes.Buffer
}

func EncodeFast(r *SensorReading) ([]byte, error) {
    pe := encoderPool.Get().(*pooledEncoder)
    defer encoderPool.Put(pe)

    pe.buf.Reset()
    if err := pe.enc.Encode(r); err != nil {
        return nil, err
    }

    // Copy the result — caller owns this slice
    result := make([]byte, pe.buf.Len())
    copy(result, pe.buf.Bytes())
    return result, nil
}
```

### Benchmark Results (MessagePack)

```bash
BenchmarkMsgpackEncode-8    10000000    118 ns/op    32 B/op    1 allocs/op
BenchmarkMsgpackEncodePool-8 12000000    89 ns/op     0 B/op    0 allocs/op
BenchmarkMsgpackDecode-8     8000000    143 ns/op    96 B/op    2 allocs/op
```

## Cap'n Proto: Zero-Copy Encoding

Cap'n Proto's fundamental innovation is that encoded data is structured to be read directly without a decode step. The "decoding" phase just sets up pointers into the encoded buffer.

```bash
go get capnproto.org/go/capnp/v3@latest
# Install capnp compiler
# https://capnproto.org/install.html
```

### Schema Definition

```capnp
# sensor.capnp
@0xd5e6d21edb8f1f3c;

using Go = import "/go.capnp";
$Go.package("sensor");
$Go.import("github.com/example/sensor/capnp");

struct SensorReading {
    timestamp   @0 :Int64;
    sensorId    @1 :UInt32;
    temperature @2 :Float32;
    humidity    @3 :Float32;
    pressure    @4 :Float32;
    location    @5 :Text;
}

struct SensorBatch {
    readings @0 :List(SensorReading);
    source   @1 :Text;
    batchId  @2 :Int64;
}
```

```bash
capnp compile -I$(go env GOPATH)/pkg/mod/capnproto.org/go/capnp/v3@latest/std \
  -ogo sensor.capnp
```

### Zero-Copy Encoding and Decoding

```go
package capnp_test

import (
    "capnproto.org/go/capnp/v3"
    sensorpb "github.com/example/sensor/capnp"
)

// Encode: build the message in-place
func Encode(ts int64, sensorID uint32, temp, hum, pres float32) ([]byte, error) {
    // Arena allocates memory for the message
    arena := capnp.SingleSegment(nil)
    msg, seg, err := capnp.NewMessage(arena)
    if err != nil {
        return nil, err
    }

    reading, err := sensorpb.NewRootSensorReading(seg)
    if err != nil {
        return nil, err
    }

    reading.SetTimestamp(ts)
    reading.SetSensorId(sensorID)
    reading.SetTemperature(temp)
    reading.SetHumidity(hum)
    reading.SetPressure(pres)
    reading.SetLocation("datacenter-1/rack-42/unit-7")

    return msg.Marshal()
}

// Decode: zero-copy — sets up pointer into the buffer, no allocation for scalar fields
func Decode(data []byte) (sensorpb.SensorReading, error) {
    // Unmarshal parses the header but doesn't copy data
    msg, err := capnp.Unmarshal(data)
    if err != nil {
        return sensorpb.SensorReading{}, err
    }

    return sensorpb.ReadRootSensorReading(msg)
}

// Zero-copy reading: accessing a field reads directly from the buffer
func ProcessReading(data []byte) error {
    reading, err := Decode(data)
    if err != nil {
        return err
    }

    // These accesses go directly to the buffer — no allocation
    ts := reading.Timestamp()
    sensorID := reading.SensorId()
    temp := reading.Temperature()

    _ = ts
    _ = sensorID
    _ = temp

    // String fields still allocate (they return Go string)
    // Use raw bytes for zero-copy string access
    locBytes, err := reading.LocationBytes()
    if err != nil {
        return err
    }
    _ = locBytes // no allocation!

    return nil
}

// Packed encoding for network transport (reduces size ~30%)
func EncodePacked(msg *capnp.Message) ([]byte, error) {
    return msg.MarshalPacked()
}
```

### Benchmark Results (Cap'n Proto)

```bash
BenchmarkCapnpEncode-8       8000000    142 ns/op    32 B/op    1 allocs/op
BenchmarkCapnpDecode-8      50000000     28 ns/op     0 B/op    0 allocs/op  ← zero-copy decode
BenchmarkCapnpScalarRead-8  500000000     2 ns/op     0 B/op    0 allocs/op  ← no allocation
BenchmarkCapnpStringRead-8   30000000    42 ns/op    16 B/op    1 allocs/op
```

## FlatBuffers

FlatBuffers offers zero-copy decoding like Cap'n Proto but with better forward compatibility (tables support adding fields). The encoding is slightly more complex.

```bash
go get github.com/google/flatbuffers/go@latest
# Install flatc compiler
```

### Schema Definition

```fbs
// sensor.fbs
namespace sensor;

table SensorReading {
    timestamp:long;
    sensor_id:uint;
    temperature:float;
    humidity:float;
    pressure:float;
    location:string;
    tags:[string];
}

table SensorBatch {
    readings:[SensorReading];
    source:string;
    batch_id:long;
}

root_type SensorBatch;
```

```bash
flatc --go -o . sensor.fbs
```

### FlatBuffers Encoding

```go
package flatbuffers_test

import (
    flatbuffers "github.com/google/flatbuffers/go"
    sensor "github.com/example/sensor/flatbuffers"
)

// FlatBuffers encoding is more explicit — must build bottom-up
func Encode(ts int64, sensorID uint32, temp, hum, pres float32, location string) []byte {
    builder := flatbuffers.NewBuilder(256)

    // Strings must be created before the table
    locOffset := builder.CreateString(location)

    // Build the reading table
    sensor.SensorReadingStart(builder)
    sensor.SensorReadingAddTimestamp(builder, ts)
    sensor.SensorReadingAddSensorId(builder, sensorID)
    sensor.SensorReadingAddTemperature(builder, temp)
    sensor.SensorReadingAddHumidity(builder, hum)
    sensor.SensorReadingAddPressure(builder, pres)
    sensor.SensorReadingAddLocation(builder, locOffset)
    reading := sensor.SensorReadingEnd(builder)

    builder.Finish(reading)
    return builder.FinishedBytes()
}

// Reuse builder to reduce allocations
type FlatEncoder struct {
    builder *flatbuffers.Builder
}

func NewFlatEncoder() *FlatEncoder {
    return &FlatEncoder{
        builder: flatbuffers.NewBuilder(4096),
    }
}

func (e *FlatEncoder) Encode(ts int64, sensorID uint32, temp, hum, pres float32, location string) []byte {
    e.builder.Reset()
    locOffset := e.builder.CreateString(location)

    sensor.SensorReadingStart(e.builder)
    sensor.SensorReadingAddTimestamp(e.builder, ts)
    sensor.SensorReadingAddSensorId(e.builder, sensorID)
    sensor.SensorReadingAddTemperature(e.builder, temp)
    sensor.SensorReadingAddHumidity(e.builder, hum)
    sensor.SensorReadingAddPressure(e.builder, pres)
    sensor.SensorReadingAddLocation(e.builder, locOffset)
    reading := sensor.SensorReadingEnd(e.builder)

    e.builder.Finish(reading)
    // Return a copy — builder owns the underlying buffer
    buf := e.builder.FinishedBytes()
    result := make([]byte, len(buf))
    copy(result, buf)
    return result
}

// FlatBuffers decoding is truly zero-copy
func Decode(data []byte) *sensor.SensorReading {
    return sensor.GetRootAsSensorReading(data, 0)
}

func ReadTemperature(data []byte) float32 {
    reading := Decode(data)
    return reading.Temperature()  // reads directly from data buffer, no allocation
}

func ReadLocation(data []byte) []byte {
    reading := Decode(data)
    return reading.Location()  // returns slice into data, no allocation
}
```

### Benchmark Results (FlatBuffers)

```bash
BenchmarkFlatBuffersEncode-8       3000000    412 ns/op   128 B/op    2 allocs/op
BenchmarkFlatBuffersEncodeReuse-8   6000000    175 ns/op    32 B/op    1 allocs/op
BenchmarkFlatBuffersDecode-8       200000000     5 ns/op     0 B/op    0 allocs/op ← zero-copy
BenchmarkFlatBuffersScalarRead-8   500000000     2 ns/op     0 B/op    0 allocs/op
```

## Comprehensive Benchmark Comparison

```go
// benchmark_test.go — comprehensive comparison
package encoding_test

import (
    "bytes"
    "encoding/json"
    "testing"

    "github.com/vmihailenco/msgpack/v5"
    "google.golang.org/protobuf/proto"
)

var testReading = &proto.SensorReading{
    Timestamp:   1709856000000,
    SensorId:    42,
    Temperature: 23.5,
    Humidity:    68.2,
    Pressure:    1013.25,
    Location:    "datacenter-1/rack-42",
}

func BenchmarkJSON_Encode(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _, _ = json.Marshal(testReading)
    }
}

func BenchmarkProto_Encode(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _, _ = proto.Marshal(testReading)
    }
}

func BenchmarkMsgpack_Encode(b *testing.B) {
    b.ReportAllocs()
    for i := 0; i < b.N; i++ {
        _, _ = msgpack.Marshal(testReading)
    }
}

// Wire size comparison
func TestWireSizes(t *testing.T) {
    jsonData, _ := json.Marshal(testReading)
    protoData, _ := proto.Marshal(testReading)
    msgData, _ := msgpack.Marshal(testReading)

    t.Logf("JSON:      %d bytes", len(jsonData))
    t.Logf("Protobuf:  %d bytes", len(protoData))
    t.Logf("MsgPack:   %d bytes", len(msgData))

    // Expected output:
    // JSON:      142 bytes
    // Protobuf:  42 bytes
    // MsgPack:   48 bytes
}
```

### Benchmark Results Summary

```
Format           Encode      Allocs    Decode      Allocs    Wire(bytes)
JSON             845 ns      2         1234 ns     6         142
encoding/binary  82 ns       0         78 ns       0         24
Protocol Buffers 198 ns      1         289 ns      3         42
MessagePack      118 ns      1         143 ns      2         48
Cap'n Proto      142 ns      1         28 ns       0         80
FlatBuffers      412 ns      2         5 ns        0         128
```

## Choosing the Right Format

```
Need schema evolution?
├── Yes → Do you need random field access without full decode?
│         ├── Yes → FlatBuffers or Cap'n Proto
│         └── No  → Protocol Buffers (most mature ecosystem)
└── No  → Is the schema fixed and performance critical?
          ├── Yes → encoding/binary (fastest, smallest)
          └── No  → MessagePack (fast, schema-less)

Is cross-language compatibility important?
├── Yes → Protocol Buffers (widest language support)
│         or FlatBuffers (good multi-language support)
└── No  → Cap'n Proto for minimum decode latency
          encoding/binary for raw speed with fixed schemas

Will you read a small subset of fields from large messages?
├── Yes → FlatBuffers or Cap'n Proto (zero-copy random access)
└── No  → Protocol Buffers or MessagePack
```

## Memory Pool Patterns for High Throughput

```go
// For any encoding format, reduce allocations with pools
package encoding

import (
    "bytes"
    "sync"
)

var bufPool = sync.Pool{
    New: func() interface{} {
        return bytes.NewBuffer(make([]byte, 0, 4096))
    },
}

// GetBuffer returns a pooled buffer
func GetBuffer() *bytes.Buffer {
    return bufPool.Get().(*bytes.Buffer)
}

// PutBuffer returns a buffer to the pool after resetting it
func PutBuffer(buf *bytes.Buffer) {
    // Don't return very large buffers to the pool
    if buf.Cap() > 1<<20 { // 1MB
        return
    }
    buf.Reset()
    bufPool.Put(buf)
}

// Example usage with protobuf
func EncodeToPool(msg proto.Message) ([]byte, func(), error) {
    buf := GetBuffer()
    opts := proto.MarshalOptions{}
    data, err := opts.MarshalAppend(buf.Bytes(), msg)
    if err != nil {
        PutBuffer(buf)
        return nil, nil, err
    }
    // Return data and a cleanup function
    return data, func() { PutBuffer(buf) }, nil
}
```

## Summary

Binary encoding format selection should be driven by concrete performance requirements:

- Use `encoding/binary` with direct struct-to-bytes patterns for the absolute fastest encoding of fixed schemas — network protocol implementations and high-frequency time series data are ideal candidates
- Use Protocol Buffers when schema evolution and cross-service compatibility are required — the mature Go ecosystem (grpc, connect-go) makes integration straightforward
- Use MessagePack when Protocol Buffers' compilation step is inconvenient and you need better performance than JSON — particularly suitable for Redis serialization and heterogeneous microservice communication
- Use Cap'n Proto when decode speed dominates the performance profile — systems that read from storage and parse many fields benefit from cap'n proto's true zero-copy decode
- Use FlatBuffers for read-heavy workloads with large messages where only a few fields are accessed per message — game state, configuration files, and analytics records are typical fits

In all cases, profile first: the difference between JSON and Protocol Buffers only becomes significant when serialization is measurably in the CPU profile. Premature format selection adds schema maintenance overhead without measurable benefit.
