---
title: "Go Protobuf v2: Reflection, Editions, and Code Generation"
date: 2029-07-17T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Protobuf", "gRPC", "Code Generation", "API Design", "buf"]
categories: ["Go", "API Design", "Developer Tools"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Go's google.golang.org/protobuf (v2 API): MessageReflect API, protoc-gen-go, proto options, protobuf editions replacing syntax declarations, and buf tooling for schema management in production."
more_link: "yes"
url: "/go-protobuf-v2-reflection-editions-code-generation/"
---

The protobuf Go module underwent a complete rewrite with `google.golang.org/protobuf` (informally called v2), introducing a reflection API, improved generated code, and the `protoreflect` package that enables runtime inspection and manipulation of protobuf messages. Understanding these APIs is essential for building generic protobuf tooling, implementing custom marshaling, and working with protobuf editions—the successor to `syntax = "proto2"` and `syntax = "proto3"`.

<!--more-->

# Go Protobuf v2: Reflection, Editions, and Code Generation

## The Migration from v1 to v2

The original `github.com/golang/protobuf` package had design issues that made it difficult to implement correct reflection and generic message handling. The v2 module (`google.golang.org/protobuf`) was a ground-up redesign.

```
v1 (github.com/golang/protobuf):
  - Generated code embeds message definitions as side effects
  - Reflection via interface{} and reflection: fragile
  - No unified type system
  - Still maintained for compatibility via wrapper

v2 (google.golang.org/protobuf):
  - All messages implement proto.Message interface
  - Rich reflection via protoreflect package
  - Unified registry of types
  - Editions support (new)
  - Better JSON/text marshaling
```

The v1 package now delegates to v2 internally. If you're using `github.com/golang/protobuf`, you're already using v2 code:

```go
// The v1 package wraps v2 - they're compatible
import (
    v1 "github.com/golang/protobuf/proto"      // Legacy, wraps v2
    v2 "google.golang.org/protobuf/proto"       // Modern API
)

// Both work with the same generated code (since protoc-gen-go >= 1.20)
```

## Core Interfaces and Types

### The proto.Message Interface

Every generated message implements `proto.Message`:

```go
// proto.Message is the fundamental interface for all protobuf messages
type Message interface {
    ProtoReflect() protoreflect.Message
}

// A generated message looks like this:
type UserRequest struct {
    state         protoimpl.MessageState  // Internal state
    sizeCache     protoimpl.SizeCache
    unknownFields protoimpl.UnknownFields
    UserId        string   `protobuf:"bytes,1,opt,name=user_id,json=userId,proto3" json:"user_id,omitempty"`
    Email         string   `protobuf:"bytes,2,opt,name=email,proto3" json:"email,omitempty"`
}

func (x *UserRequest) ProtoReflect() protoreflect.Message {
    mi := &file_user_proto_msgTypes[0]
    if protoimpl.UnsafeEnabled && x != nil {
        ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
        if ms.LoadMessageInfo() == nil {
            ms.StoreMessageInfo(mi)
        }
        return ms
    }
    return mi.MessageOf(x)
}
```

### The protoreflect Package

The `protoreflect` package provides rich type information:

```go
package reflection

import (
    "fmt"

    "google.golang.org/protobuf/proto"
    "google.golang.org/protobuf/reflect/protoreflect"
    pb "yourmodule/gen/user/v1"
)

// Inspect any message's structure at runtime
func InspectMessage(msg proto.Message) {
    md := msg.ProtoReflect().Descriptor()

    fmt.Printf("Message: %s\n", md.FullName())
    fmt.Printf("Package: %s\n", md.ParentFile().Package())
    fmt.Printf("File: %s\n", md.ParentFile().Path())
    fmt.Printf("Fields (%d):\n", md.Fields().Len())

    for i := 0; i < md.Fields().Len(); i++ {
        fd := md.Fields().Get(i)
        fmt.Printf("  [%d] %s: %s (json: %s)\n",
            fd.Number(),
            fd.Name(),
            fd.Kind(),
            fd.JSONName(),
        )
        if fd.IsList() {
            fmt.Printf("       (repeated)\n")
        }
        if fd.IsMap() {
            fmt.Printf("       (map: %s -> %s)\n", fd.MapKey().Kind(), fd.MapValue().Kind())
        }
        if fd.Message() != nil {
            fmt.Printf("       (message type: %s)\n", fd.Message().FullName())
        }
        if fd.HasPresence() {
            fmt.Printf("       (has presence / optional)\n")
        }
    }

    fmt.Printf("Oneofs (%d):\n", md.Oneofs().Len())
    for i := 0; i < md.Oneofs().Len(); i++ {
        ood := md.Oneofs().Get(i)
        fmt.Printf("  %s:\n", ood.Name())
        for j := 0; j < ood.Fields().Len(); j++ {
            fmt.Printf("    - %s\n", ood.Fields().Get(j).Name())
        }
    }
}

// Example output for a User message:
// Message: user.v1.UserRequest
// Package: user.v1
// File: user/v1/user.proto
// Fields (3):
//   [1] user_id: string (json: userId)
//   [2] email: string (json: email)
//   [3] metadata: message (message type: user.v1.Metadata)
//        (has presence / optional)
```

## MessageReflect API: Reading and Writing Fields

The reflection API allows reading and writing fields without knowing the concrete type at compile time:

```go
package reflection

import (
    "fmt"

    "google.golang.org/protobuf/proto"
    "google.golang.org/protobuf/reflect/protoreflect"
    "google.golang.org/protobuf/reflect/protoregistry"
)

// GenericFieldReader reads any field from any message
func GetField(msg proto.Message, fieldName string) (interface{}, error) {
    refl := msg.ProtoReflect()
    fd := refl.Descriptor().Fields().ByTextName(fieldName)
    if fd == nil {
        // Try JSON name as fallback
        fd = refl.Descriptor().Fields().ByJSONName(fieldName)
    }
    if fd == nil {
        return nil, fmt.Errorf("field %q not found in message %s",
            fieldName, refl.Descriptor().FullName())
    }

    val := refl.Get(fd)
    return protoreflect.ValueOf(val).Interface(), nil
}

// GenericFieldWriter sets any field on any message
func SetField(msg proto.Message, fieldName string, value interface{}) error {
    refl := msg.ProtoReflect()
    fd := refl.Descriptor().Fields().ByTextName(fieldName)
    if fd == nil {
        fd = refl.Descriptor().Fields().ByJSONName(fieldName)
    }
    if fd == nil {
        return fmt.Errorf("field %q not found", fieldName)
    }

    switch v := value.(type) {
    case string:
        refl.Set(fd, protoreflect.ValueOfString(v))
    case int64:
        refl.Set(fd, protoreflect.ValueOfInt64(v))
    case int32:
        refl.Set(fd, protoreflect.ValueOfInt32(v))
    case float64:
        refl.Set(fd, protoreflect.ValueOfFloat64(v))
    case bool:
        refl.Set(fd, protoreflect.ValueOfBool(v))
    case []byte:
        refl.Set(fd, protoreflect.ValueOfBytes(v))
    case proto.Message:
        refl.Set(fd, protoreflect.ValueOfMessage(v.ProtoReflect()))
    default:
        return fmt.Errorf("unsupported value type %T for field %s", value, fieldName)
    }

    return nil
}

// Walk all fields and their values in a message
func WalkFields(msg proto.Message, fn func(fd protoreflect.FieldDescriptor, val protoreflect.Value)) {
    refl := msg.ProtoReflect()
    refl.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
        fn(fd, v)
        // Recurse into nested messages
        if fd.Kind() == protoreflect.MessageKind && !fd.IsList() && !fd.IsMap() {
            WalkFields(v.Message().Interface(), fn)
        }
        return true // Continue iteration
    })
}

// Clone any protobuf message (deep copy)
func CloneMessage(msg proto.Message) proto.Message {
    return proto.Clone(msg)
}

// Merge: update fields from source into destination
func MergeMessages(dst, src proto.Message) {
    proto.Merge(dst, src)
}

// Check equality
func MessagesEqual(a, b proto.Message) bool {
    return proto.Equal(a, b)
}
```

### Building a Generic Mapper

```go
// Map any protobuf message to a map[string]interface{} (useful for logging)
func MessageToMap(msg proto.Message) map[string]interface{} {
    result := make(map[string]interface{})
    refl := msg.ProtoReflect()

    refl.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
        key := string(fd.JSONName())

        switch fd.Kind() {
        case protoreflect.StringKind:
            result[key] = v.String()
        case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
            result[key] = v.Int()
        case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
            result[key] = v.Int()
        case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
            result[key] = v.Uint()
        case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
            result[key] = v.Uint()
        case protoreflect.FloatKind:
            result[key] = float32(v.Float())
        case protoreflect.DoubleKind:
            result[key] = v.Float()
        case protoreflect.BoolKind:
            result[key] = v.Bool()
        case protoreflect.BytesKind:
            result[key] = v.Bytes()
        case protoreflect.EnumKind:
            enumVal := fd.Enum().Values().ByNumber(v.Enum())
            if enumVal != nil {
                result[key] = string(enumVal.Name())
            } else {
                result[key] = v.Enum()
            }
        case protoreflect.MessageKind, protoreflect.GroupKind:
            if fd.IsMap() {
                mapResult := make(map[string]interface{})
                v.Map().Range(func(mk protoreflect.MapKey, mv protoreflect.Value) bool {
                    mapResult[mk.String()] = mv.Interface()
                    return true
                })
                result[key] = mapResult
            } else if fd.IsList() {
                list := v.List()
                items := make([]interface{}, list.Len())
                for i := 0; i < list.Len(); i++ {
                    if fd.Kind() == protoreflect.MessageKind {
                        items[i] = MessageToMap(list.Get(i).Message().Interface())
                    } else {
                        items[i] = list.Get(i).Interface()
                    }
                }
                result[key] = items
            } else {
                result[key] = MessageToMap(v.Message().Interface())
            }
        }
        return true
    })

    return result
}
```

## protoc-gen-go: Code Generation

### Installing the Toolchain

```bash
# Install protoc
# On Ubuntu/Debian:
apt-get install -y protobuf-compiler

# Or download directly
PROTOC_VERSION=25.3
curl -LO "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip"
unzip protoc-${PROTOC_VERSION}-linux-x86_64.zip -d /usr/local

# Install Go plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Verify versions
protoc --version         # libprotoc 25.3
protoc-gen-go --version  # protoc-gen-go v1.32.0
```

### Proto File Structure

```protobuf
// user/v1/user.proto
syntax = "proto3";

package user.v1;

option go_package = "github.com/yourorg/yourrepo/gen/user/v1;userv1";

import "google/protobuf/timestamp.proto";
import "google/protobuf/field_mask.proto";
import "validate/validate.proto"; // buf validate / protoc-gen-validate

// Custom options (for validation, OpenAPI, etc.)
import "google/api/annotations.proto";

message User {
  string id = 1;
  string email = 2;
  string name = 3;
  UserStatus status = 4;
  google.protobuf.Timestamp created_at = 5;
  google.protobuf.Timestamp updated_at = 6;

  // Optional fields (proto3 optional - adds has_* methods)
  optional string phone = 7;

  // Oneof: only one of these can be set
  oneof payment_method {
    CreditCard credit_card = 8;
    BankAccount bank_account = 9;
  }

  // Repeated (array)
  repeated string roles = 10;

  // Map
  map<string, string> metadata = 11;
}

enum UserStatus {
  USER_STATUS_UNSPECIFIED = 0;  // Default; always 0 and UNSPECIFIED
  USER_STATUS_ACTIVE = 1;
  USER_STATUS_INACTIVE = 2;
  USER_STATUS_BANNED = 3;
}

message CreditCard {
  string last_four = 1;
  string brand = 2;
  int32 exp_month = 3;
  int32 exp_year = 4;
}

message BankAccount {
  string routing_number = 1;
  string account_last_four = 2;
  string account_type = 3;
}

// Service definition
service UserService {
  // Unary RPC
  rpc GetUser(GetUserRequest) returns (GetUserResponse) {
    option (google.api.http) = {
      get: "/v1/users/{user_id}"
    };
  }

  // Server streaming
  rpc ListUsers(ListUsersRequest) returns (stream User) {
    option (google.api.http) = {
      get: "/v1/users"
    };
  }

  // Client streaming (upload)
  rpc BulkCreateUsers(stream CreateUserRequest) returns (BulkCreateUsersResponse);

  // Bidirectional streaming
  rpc SyncUsers(stream SyncUserRequest) returns (stream SyncUserResponse);
}

message GetUserRequest {
  string user_id = 1;
  google.protobuf.FieldMask field_mask = 2;  // Partial reads
}

message GetUserResponse {
  User user = 1;
}

message ListUsersRequest {
  int32 page_size = 1;
  string page_token = 2;
  string filter = 3;
  google.protobuf.FieldMask field_mask = 4;
}

message CreateUserRequest {
  User user = 1;
}

message BulkCreateUsersResponse {
  repeated string created_ids = 1;
  repeated string failed_emails = 2;
  int32 total_created = 3;
}

message SyncUserRequest {
  string client_id = 1;
  repeated string user_ids = 2;
}

message SyncUserResponse {
  repeated User users = 1;
  int64 sync_token = 2;
}
```

### Generating Code

```bash
# Direct protoc invocation
protoc \
  --proto_path=. \
  --proto_path=third_party \
  --go_out=gen \
  --go_opt=paths=source_relative \
  --go-grpc_out=gen \
  --go-grpc_opt=paths=source_relative \
  user/v1/user.proto

# Generated files:
# gen/user/v1/user.pb.go        (message types)
# gen/user/v1/user_grpc.pb.go   (service client/server interfaces)
```

## Proto Options

Options add metadata to proto elements:

```protobuf
// Custom options require defining them first
syntax = "proto3";

import "google/protobuf/descriptor.proto";

// Define custom field option
extend google.protobuf.FieldOptions {
  // Marks fields that contain PII
  bool pii = 50000;
  // Minimum/maximum value for numeric fields
  optional double min_value = 50001;
  optional double max_value = 50002;
}

// Define custom message option
extend google.protobuf.MessageOptions {
  // Table name for ORM generation
  string db_table = 50010;
}

// Using the options
message UserProfile {
  option (db_table) = "user_profiles";

  string id = 1;

  string email = 2 [(pii) = true];
  string phone = 3 [(pii) = true];

  int32 age = 4 [
    (min_value) = 0,
    (max_value) = 150
  ];
}
```

```go
// Reading custom options via reflection
package options

import (
    "fmt"

    "google.golang.org/protobuf/proto"
    "google.golang.org/protobuf/reflect/protoreflect"
    // Import your generated options package
    pb "yourmodule/gen/options/v1"
)

func FindPIIFields(msg proto.Message) []string {
    var piiFields []string
    md := msg.ProtoReflect().Descriptor()

    for i := 0; i < md.Fields().Len(); i++ {
        fd := md.Fields().Get(i)
        opts := fd.Options()
        if opts == nil {
            continue
        }

        // Check if our custom option is set
        if proto.HasExtension(opts, pb.E_Pii) {
            val := proto.GetExtension(opts, pb.E_Pii)
            if isPii, ok := val.(bool); ok && isPii {
                piiFields = append(piiFields, string(fd.Name()))
            }
        }
    }

    return piiFields
}

// Middleware that redacts PII fields before logging
func RedactPII(msg proto.Message) proto.Message {
    cloned := proto.Clone(msg)
    refl := cloned.ProtoReflect()
    md := refl.Descriptor()

    for i := 0; i < md.Fields().Len(); i++ {
        fd := md.Fields().Get(i)
        opts := fd.Options()
        if opts == nil {
            continue
        }

        if proto.HasExtension(opts, pb.E_Pii) {
            if isPii, ok := proto.GetExtension(opts, pb.E_Pii).(bool); ok && isPii {
                // Clear PII field
                refl.Clear(fd)
            }
        }
    }

    return cloned
}
```

## Protobuf Editions

Protobuf editions replace `syntax = "proto2"` and `syntax = "proto3"` with a more fine-grained feature control system:

```protobuf
// Old style (deprecated but still supported)
syntax = "proto3";

// New style: editions
edition = "2023";

// Editions allow per-file, per-message, and per-field feature overrides
// This replaces the coarse-grained proto2/proto3 distinction

message ExampleMessage {
  // In proto3: fields are optional by default (no presence)
  // In editions: you can explicitly control presence
  string id = 1 [
    features.field_presence = IMPLICIT  // proto3 behavior
  ];

  // Optional with presence (proto2 behavior available in editions)
  string email = 2 [
    features.field_presence = EXPLICIT  // Adds has_email() method
  ];

  // Required fields (proto2 only) - available in editions with features
  string name = 3 [
    features.field_presence = LEGACY_REQUIRED
  ];
}

// File-level feature defaults (applies to all elements unless overridden)
option features.field_presence = EXPLICIT;  // Opt into presence tracking
option features.enum_type = OPEN;           // Allow unknown enum values
option features.repeated_field_encoding = PACKED;
option features.utf8_validation = VERIFY;
option features.message_encoding = LENGTH_PREFIXED;
option features.json_format = ALLOW;
```

### Migration from proto2/proto3

```bash
# buf can migrate files to editions format
buf migrate --from-edition "proto3" --to-edition "2023" user/v1/user.proto

# Or use the Protobuf compiler's migration tool
protoc --edition_defaults_out=. user/v1/user.proto
```

## buf Tooling: Schema Management

`buf` is the modern replacement for raw `protoc` and provides linting, breaking change detection, and a schema registry:

### buf.yaml Configuration

```yaml
# buf.yaml
version: v2

# Module configuration
name: buf.build/yourorg/yourapi

# Lint rules
lint:
  use:
    - DEFAULT
    - COMMENTS  # Require comments on all public elements
  except:
    - PACKAGE_VERSION_SUFFIX  # Allow packages without version suffix
  ignore:
    - google/  # Don't lint imported well-known types

# Breaking change detection rules
breaking:
  use:
    - FILE  # Detect file-level breaking changes
  except:
    - EXTENSION_NO_DELETE  # Allow removing extensions

# Dependencies (from Buf Schema Registry)
deps:
  - buf.build/googleapis/googleapis
  - buf.build/bufbuild/protovalidate
```

### buf.gen.yaml: Code Generation

```yaml
# buf.gen.yaml
version: v2

managed:
  enabled: true
  # Automatically set go_package options
  override:
    - file_option: go_package_prefix
      value: github.com/yourorg/yourrepo/gen

plugins:
  # Generate Go message types
  - remote: buf.build/protocolbuffers/go
    out: gen
    opt:
      - paths=source_relative

  # Generate gRPC service code
  - remote: buf.build/grpc/go
    out: gen
    opt:
      - paths=source_relative
      - require_unimplemented_servers=true

  # Generate gRPC-Gateway (REST API from gRPC)
  - remote: buf.build/grpc-ecosystem/gateway
    out: gen
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  # Generate OpenAPI v3 documentation
  - remote: buf.build/grpc-ecosystem/openapiv2
    out: docs/openapi
    opt:
      - use_json_names_for_fields=true
      - simple_operation_ids=false

  # Generate validation code (buf validate)
  - remote: buf.build/bufbuild/validate-go
    out: gen
    opt:
      - paths=source_relative

inputs:
  - directory: proto

```

### buf Commands

```bash
# Install buf
go install github.com/bufbuild/buf/cmd/buf@latest

# Lint proto files
buf lint

# Check for breaking changes against a specific tag
buf breaking --against '.git#tag=v1.2.0'

# Or against the main branch
buf breaking --against '.git#branch=main'

# Generate code from all proto files
buf generate

# Format proto files
buf format -w

# Push to Buf Schema Registry (BSR)
buf push

# Pull dependencies
buf dep update

# List all linting issues with descriptions
buf lint --error-format=text

# Example lint output:
# user/v1/user.proto:1:1:Package name "user.v1" should be suffixed with a correctly versioned value such as "v1" or "v1beta1", not "v1" (use V1 not v1)
# user/v1/user.proto:12:1:RPC "GetUser" has no comment
```

### protovalidate: Request Validation

```protobuf
// user/v1/user.proto
syntax = "proto3";
edition = "2023";

import "buf/validate/validate.proto";

message CreateUserRequest {
  string email = 1 [
    (buf.validate.field).required = true,
    (buf.validate.field).string.email = true,
    (buf.validate.field).string.max_len = 254
  ];

  string name = 2 [
    (buf.validate.field).required = true,
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 100,
    (buf.validate.field).string.pattern = "^[a-zA-Z0-9 .-]+$"
  ];

  int32 age = 3 [
    (buf.validate.field).int32.gte = 0,
    (buf.validate.field).int32.lte = 150
  ];

  repeated string roles = 4 [
    (buf.validate.field).repeated.min_items = 1,
    (buf.validate.field).repeated.max_items = 10,
    (buf.validate.field).repeated.items.string.in = ["admin", "user", "viewer"]
  ];
}
```

```go
// Validating requests using protovalidate
package validation

import (
    "context"
    "fmt"

    "buf.build/gen/go/bufbuild/protovalidate/protocolbuffers/go/buf/validate"
    "github.com/bufbuild/protovalidate-go"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
    "google.golang.org/protobuf/proto"
)

// gRPC interceptor that validates all incoming requests
func ValidationInterceptor() grpc.UnaryServerInterceptor {
    validator, err := protovalidate.New()
    if err != nil {
        panic(fmt.Sprintf("creating validator: %v", err))
    }

    return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
        if msg, ok := req.(proto.Message); ok {
            if err := validator.Validate(msg); err != nil {
                var valErr *protovalidate.ValidationError
                if errors.As(err, &valErr) {
                    return nil, status.Error(codes.InvalidArgument,
                        formatValidationError(valErr))
                }
                return nil, status.Error(codes.Internal,
                    fmt.Sprintf("validation error: %v", err))
            }
        }
        return handler(ctx, req)
    }
}

func formatValidationError(err *protovalidate.ValidationError) string {
    msg := "validation failed:"
    for _, v := range err.Violations {
        msg += fmt.Sprintf("\n  - %s: %s", v.FieldPath, v.Message)
    }
    return msg
}
```

## Type Registry and Dynamic Messages

```go
package registry

import (
    "fmt"

    "google.golang.org/protobuf/proto"
    "google.golang.org/protobuf/reflect/protodesc"
    "google.golang.org/protobuf/reflect/protoregistry"
    "google.golang.org/protobuf/types/descriptorpb"
    "google.golang.org/protobuf/types/dynamicpb"
    "google.golang.org/protobuf/types/known/anypb"
)

// Look up a message type by full name
func GetMessageType(fullName string) (protoreflect.MessageType, error) {
    mt, err := protoregistry.GlobalTypes.FindMessageByName(
        protoreflect.FullName(fullName))
    if err != nil {
        return nil, fmt.Errorf("message type %q not found: %w", fullName, err)
    }
    return mt, nil
}

// Create a message instance by type name (useful for Any unpacking)
func CreateMessage(fullName string) (proto.Message, error) {
    mt, err := GetMessageType(fullName)
    if err != nil {
        return nil, err
    }
    return mt.New().Interface(), nil
}

// Unpack an Any message to its concrete type
func UnpackAny(any *anypb.Any) (proto.Message, error) {
    return anypb.UnmarshalNew(any, proto.UnmarshalOptions{})
}

// Dynamic messages: create messages at runtime without generated code
func CreateDynamicMessage(fileDescData []byte, msgName string) (proto.Message, error) {
    // Parse the file descriptor
    fd := &descriptorpb.FileDescriptorProto{}
    if err := proto.Unmarshal(fileDescData, fd); err != nil {
        return nil, fmt.Errorf("parsing file descriptor: %w", err)
    }

    // Build a file descriptor from the proto
    files, err := protodesc.NewFile(fd, nil)
    if err != nil {
        return nil, fmt.Errorf("building file descriptor: %w", err)
    }

    // Find the message descriptor
    md := files.Messages().ByName(protoreflect.Name(msgName))
    if md == nil {
        return nil, fmt.Errorf("message %q not found in file", msgName)
    }

    // Create a dynamic message
    dynMsg := dynamicpb.NewMessage(md)
    return dynMsg, nil
}
```

## gRPC Server Implementation

```go
package server

import (
    "context"
    "fmt"
    "io"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    pb "yourmodule/gen/user/v1"
)

type UserServiceServer struct {
    pb.UnimplementedUserServiceServer  // Must embed for forward compatibility
    userStore UserStore
}

func (s *UserServiceServer) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.GetUserResponse, error) {
    user, err := s.userStore.Get(ctx, req.UserId)
    if err != nil {
        if isNotFound(err) {
            return nil, status.Errorf(codes.NotFound, "user %q not found", req.UserId)
        }
        return nil, status.Errorf(codes.Internal, "database error: %v", err)
    }

    // Apply field mask if provided
    if req.FieldMask != nil && len(req.FieldMask.Paths) > 0 {
        req.FieldMask.Normalize()
        if !req.FieldMask.IsValid(user) {
            return nil, status.Error(codes.InvalidArgument, "invalid field mask")
        }
        req.FieldMask.Filter(user)
    }

    return &pb.GetUserResponse{User: user}, nil
}

func (s *UserServiceServer) ListUsers(req *pb.ListUsersRequest, stream pb.UserService_ListUsersServer) error {
    users, err := s.userStore.List(stream.Context(), req.Filter, int(req.PageSize))
    if err != nil {
        return status.Errorf(codes.Internal, "list users: %v", err)
    }

    for _, user := range users {
        if err := stream.Send(user); err != nil {
            if err == io.EOF {
                return nil  // Client disconnected gracefully
            }
            return status.Errorf(codes.Unavailable, "send: %v", err)
        }
    }

    return nil
}

func (s *UserServiceServer) BulkCreateUsers(stream pb.UserService_BulkCreateUsersServer) error {
    var createdIDs []string
    var failedEmails []string

    for {
        req, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return status.Errorf(codes.Internal, "receive: %v", err)
        }

        id, err := s.userStore.Create(stream.Context(), req.User)
        if err != nil {
            failedEmails = append(failedEmails, req.User.Email)
            continue
        }
        createdIDs = append(createdIDs, id)
    }

    return stream.SendAndClose(&pb.BulkCreateUsersResponse{
        CreatedIds:    createdIDs,
        FailedEmails:  failedEmails,
        TotalCreated:  int32(len(createdIDs)),
    })
}
```

## Testing Protobuf Code

```go
package server_test

import (
    "context"
    "testing"

    "github.com/google/go-cmp/cmp"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/test/bufconn"
    "google.golang.org/protobuf/proto"
    "google.golang.org/protobuf/testing/protocmp"

    pb "yourmodule/gen/user/v1"
    "yourmodule/internal/server"
)

// bufconn: in-memory gRPC connection for testing
func setupTestServer(t *testing.T) pb.UserServiceClient {
    t.Helper()

    lis := bufconn.Listen(1024 * 1024)
    s := grpc.NewServer()
    pb.RegisterUserServiceServer(s, server.NewUserServiceServer(newFakeUserStore()))

    go func() {
        if err := s.Serve(lis); err != nil {
            t.Logf("server error: %v", err)
        }
    }()

    t.Cleanup(func() {
        s.Stop()
        lis.Close()
    })

    conn, err := grpc.DialContext(
        context.Background(),
        "bufconn",
        grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
            return lis.DialContext(ctx)
        }),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        t.Fatalf("dial: %v", err)
    }
    t.Cleanup(conn.Close)

    return pb.NewUserServiceClient(conn)
}

func TestGetUser(t *testing.T) {
    client := setupTestServer(t)

    tests := []struct {
        name      string
        req       *pb.GetUserRequest
        wantUser  *pb.User
        wantCode  codes.Code
    }{
        {
            name:     "success",
            req:      &pb.GetUserRequest{UserId: "user-1"},
            wantUser: &pb.User{Id: "user-1", Email: "alice@example.com"},
        },
        {
            name:     "not found",
            req:      &pb.GetUserRequest{UserId: "nonexistent"},
            wantCode: codes.NotFound,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            resp, err := client.GetUser(context.Background(), tt.req)

            if tt.wantCode != codes.OK {
                if status.Code(err) != tt.wantCode {
                    t.Errorf("expected code %v, got %v", tt.wantCode, status.Code(err))
                }
                return
            }

            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }

            // Use protocmp for proper proto comparison (not reflect.DeepEqual)
            if diff := cmp.Diff(tt.wantUser, resp.User,
                protocmp.Transform()); diff != "" {
                t.Errorf("user mismatch (-want +got):\n%s", diff)
            }
        })
    }
}
```

## Summary

The Go protobuf v2 API provides a rich ecosystem for working with structured data at scale:

1. **`proto.Message` interface** — the foundation; every generated type implements it via `ProtoReflect()`
2. **`protoreflect` package** — runtime inspection of message descriptors, field metadata, and values without code generation
3. **`MessageReflect` API** — generic field access enables building schema-agnostic tools (loggers, validators, mappers)
4. **Custom proto options** — extend proto descriptors with application-specific metadata (PII flags, DB table names, validation rules)
5. **Protobuf editions** — replace proto2/proto3 syntax with fine-grained per-element feature control
6. **buf tooling** — linting, breaking change detection, and the Buf Schema Registry replace raw protoc workflows
7. **protovalidate** — declarative field validation directly in proto files, replacing hand-written validation code

The reflection API is the key differentiator of v2: it enables building powerful generic tooling—automatic redaction of PII fields, dynamic message construction from file descriptors, and schema-driven UI generation—all without compile-time knowledge of the specific message types.
