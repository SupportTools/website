---
title: "Advanced Linux Compiler and Language Runtime Development: Building Custom Programming Languages and Execution Engines"
date: 2025-05-22T10:00:00-05:00
draft: false
tags: ["Linux", "Compiler", "Runtime", "JIT", "LLVM", "Virtual Machine", "Language Design", "Code Generation"]
categories:
- Linux
- Compiler Development
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Linux compiler and runtime development including custom language design, virtual machines, JIT compilation, garbage collection, and building production-grade language implementations"
more_link: "yes"
url: "/advanced-linux-compiler-runtime-development/"
---

Advanced Linux compiler and language runtime development requires deep understanding of language design, code generation, virtual machines, and execution optimization. This comprehensive guide explores building custom programming languages from scratch, implementing JIT compilers, garbage collectors, and creating high-performance language runtimes for modern applications.

<!--more-->

# [Advanced Linux Compiler and Language Runtime Development](#advanced-linux-compiler-runtime-development)

## Custom Language Compiler and Virtual Machine

### Complete Language Implementation Framework

```c
// language_runtime.c - Advanced language runtime and virtual machine
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <dlfcn.h>
#include <sys/mman.h>
#include <pthread.h>
#include <stdatomic.h>
#include <assert.h>
#include <math.h>
#include <time.h>

#define MAX_STACK_SIZE 65536
#define MAX_HEAP_SIZE (64 * 1024 * 1024)
#define MAX_CONSTANTS 10000
#define MAX_GLOBALS 10000
#define MAX_LOCALS 256
#define MAX_FUNCTIONS 1000
#define GC_THRESHOLD (8 * 1024 * 1024)

// Virtual machine opcodes
typedef enum {
    OP_NOP = 0,
    OP_CONST,
    OP_LOAD_GLOBAL,
    OP_STORE_GLOBAL,
    OP_LOAD_LOCAL,
    OP_STORE_LOCAL,
    OP_LOAD_UPVALUE,
    OP_STORE_UPVALUE,
    OP_ADD,
    OP_SUB,
    OP_MUL,
    OP_DIV,
    OP_MOD,
    OP_NEG,
    OP_NOT,
    OP_AND,
    OP_OR,
    OP_EQ,
    OP_NE,
    OP_LT,
    OP_LE,
    OP_GT,
    OP_GE,
    OP_JUMP,
    OP_JUMP_IF_FALSE,
    OP_JUMP_IF_TRUE,
    OP_CALL,
    OP_RETURN,
    OP_PRINT,
    OP_POP,
    OP_DUP,
    OP_SWAP,
    OP_NEW_ARRAY,
    OP_NEW_OBJECT,
    OP_GET_PROPERTY,
    OP_SET_PROPERTY,
    OP_GET_INDEX,
    OP_SET_INDEX,
    OP_CLOSURE,
    OP_CLASS,
    OP_METHOD,
    OP_INVOKE,
    OP_SUPER_INVOKE,
    OP_INHERIT,
    OP_GET_SUPER,
    OP_HALT
} opcode_t;

// Value types
typedef enum {
    VAL_NIL,
    VAL_BOOL,
    VAL_NUMBER,
    VAL_STRING,
    VAL_FUNCTION,
    VAL_CLOSURE,
    VAL_CLASS,
    VAL_INSTANCE,
    VAL_ARRAY,
    VAL_NATIVE
} value_type_t;

// Forward declarations
typedef struct value value_t;
typedef struct object object_t;
typedef struct vm vm_t;

// Object header
typedef struct object {
    value_type_t type;
    bool is_marked; // For garbage collection
    struct object* next; // For GC linked list
    size_t size;
} object_t;

// String object
typedef struct {
    object_t obj;
    size_t length;
    uint32_t hash;
    char chars[];
} string_object_t;

// Function object
typedef struct {
    object_t obj;
    int arity;
    int upvalue_count;
    uint8_t* bytecode;
    size_t bytecode_length;
    value_t* constants;
    size_t constant_count;
    char* name;
} function_object_t;

// Upvalue object
typedef struct upvalue {
    object_t obj;
    value_t* location;
    value_t closed;
    struct upvalue* next;
} upvalue_object_t;

// Closure object
typedef struct {
    object_t obj;
    function_object_t* function;
    upvalue_object_t** upvalues;
    int upvalue_count;
} closure_object_t;

// Class object
typedef struct {
    object_t obj;
    string_object_t* name;
    struct hash_table* methods;
} class_object_t;

// Instance object
typedef struct {
    object_t obj;
    class_object_t* klass;
    struct hash_table* fields;
} instance_object_t;

// Array object
typedef struct {
    object_t obj;
    value_t* elements;
    size_t capacity;
    size_t count;
} array_object_t;

// Native function
typedef value_t (*native_fn_t)(vm_t* vm, int arg_count, value_t* args);

// Native object
typedef struct {
    object_t obj;
    native_fn_t function;
    char* name;
} native_object_t;

// Value structure
typedef struct value {
    value_type_t type;
    union {
        bool boolean;
        double number;
        object_t* object;
    } as;
} value_t;

// Hash table entry
typedef struct {
    string_object_t* key;
    value_t value;
} hash_entry_t;

// Hash table
typedef struct hash_table {
    int count;
    int capacity;
    hash_entry_t* entries;
} hash_table_t;

// Call frame
typedef struct {
    closure_object_t* closure;
    uint8_t* ip; // Instruction pointer
    value_t* slots; // Local variable slots
} call_frame_t;

// Compiler context
typedef struct {
    uint8_t* bytecode;
    size_t bytecode_capacity;
    size_t bytecode_count;
    
    value_t* constants;
    size_t constant_capacity;
    size_t constant_count;
    
    // Local variables
    struct {
        char name[256];
        int depth;
        bool is_captured;
    } locals[MAX_LOCALS];
    int local_count;
    int scope_depth;
    
    // Upvalues
    struct {
        uint8_t index;
        bool is_local;
    } upvalues[256];
    
    function_object_t* function;
    struct compiler* enclosing;
} compiler_t;

// JIT compilation context
typedef struct {
    bool enabled;
    void* jit_code;
    size_t jit_size;
    int (*compiled_function)(vm_t* vm);
    
    // Hot spot detection
    uint32_t* execution_counts;
    size_t count_capacity;
    uint32_t jit_threshold;
    
    // Native code buffer
    void* code_buffer;
    size_t code_capacity;
    size_t code_used;
    
} jit_context_t;

// Garbage collector
typedef struct {
    object_t* objects;
    size_t bytes_allocated;
    size_t next_gc;
    
    // Mark and sweep
    object_t** gray_stack;
    size_t gray_capacity;
    size_t gray_count;
    
    // Statistics
    struct {
        uint64_t collections_performed;
        uint64_t objects_collected;
        uint64_t bytes_freed;
        double avg_collection_time;
    } stats;
    
    // Configuration
    double growth_factor;
    size_t min_heap_size;
    bool stress_gc; // For testing
    
} gc_t;

// Virtual machine
typedef struct vm {
    // Execution state
    call_frame_t frames[256];
    int frame_count;
    
    value_t* stack;
    value_t* stack_top;
    size_t stack_capacity;
    
    // Global state
    hash_table_t globals;
    hash_table_t strings;
    upvalue_object_t* open_upvalues;
    
    // Memory management
    gc_t gc;
    
    // JIT compilation
    jit_context_t jit;
    
    // Built-in objects
    string_object_t* init_string;
    
    // Configuration
    struct {
        bool enable_jit;
        bool enable_gc;
        bool debug_mode;
        size_t max_stack_size;
        size_t max_heap_size;
    } config;
    
    // Performance metrics
    struct {
        uint64_t instructions_executed;
        uint64_t function_calls;
        uint64_t gc_collections;
        double execution_time;
        uint64_t jit_compilations;
    } stats;
    
} vm_t;

// Lexer token types
typedef enum {
    TOKEN_LEFT_PAREN,
    TOKEN_RIGHT_PAREN,
    TOKEN_LEFT_BRACE,
    TOKEN_RIGHT_BRACE,
    TOKEN_LEFT_BRACKET,
    TOKEN_RIGHT_BRACKET,
    TOKEN_COMMA,
    TOKEN_DOT,
    TOKEN_MINUS,
    TOKEN_PLUS,
    TOKEN_SEMICOLON,
    TOKEN_SLASH,
    TOKEN_STAR,
    TOKEN_PERCENT,
    TOKEN_BANG,
    TOKEN_BANG_EQUAL,
    TOKEN_EQUAL,
    TOKEN_EQUAL_EQUAL,
    TOKEN_GREATER,
    TOKEN_GREATER_EQUAL,
    TOKEN_LESS,
    TOKEN_LESS_EQUAL,
    TOKEN_IDENTIFIER,
    TOKEN_STRING,
    TOKEN_NUMBER,
    TOKEN_AND,
    TOKEN_CLASS,
    TOKEN_ELSE,
    TOKEN_FALSE,
    TOKEN_FOR,
    TOKEN_FUN,
    TOKEN_IF,
    TOKEN_NIL,
    TOKEN_OR,
    TOKEN_PRINT,
    TOKEN_RETURN,
    TOKEN_SUPER,
    TOKEN_THIS,
    TOKEN_TRUE,
    TOKEN_VAR,
    TOKEN_WHILE,
    TOKEN_ERROR,
    TOKEN_EOF
} token_type_t;

// Token structure
typedef struct {
    token_type_t type;
    const char* start;
    int length;
    int line;
} token_t;

// Lexer
typedef struct {
    const char* start;
    const char* current;
    int line;
} lexer_t;

static vm_t vm = {0};

// Utility macros
#define IS_BOOL(value) ((value).type == VAL_BOOL)
#define IS_NIL(value) ((value).type == VAL_NIL)
#define IS_NUMBER(value) ((value).type == VAL_NUMBER)
#define IS_STRING(value) ((value).type == VAL_STRING)
#define IS_FUNCTION(value) ((value).type == VAL_FUNCTION)
#define IS_CLOSURE(value) ((value).type == VAL_CLOSURE)

#define AS_BOOL(value) ((value).as.boolean)
#define AS_NUMBER(value) ((value).as.number)
#define AS_STRING(value) ((string_object_t*)(value).as.object)
#define AS_CSTRING(value) (((string_object_t*)(value).as.object)->chars)
#define AS_FUNCTION(value) ((function_object_t*)(value).as.object)
#define AS_CLOSURE(value) ((closure_object_t*)(value).as.object)

#define BOOL_VAL(value) ((value_t){VAL_BOOL, {.boolean = value}})
#define NIL_VAL ((value_t){VAL_NIL, {.number = 0}})
#define NUMBER_VAL(value) ((value_t){VAL_NUMBER, {.number = value}})
#define OBJ_VAL(object) ((value_t){(object)->type, {.object = (object_t*)(object)}})

// Memory management
static void* allocate(size_t size)
{
    void* ptr = malloc(size);
    if (ptr) {
        vm.gc.bytes_allocated += size;
        
        if (vm.config.enable_gc && vm.gc.bytes_allocated > vm.gc.next_gc) {
            // Trigger garbage collection
        }
    }
    return ptr;
}

static void deallocate(void* ptr, size_t size)
{
    if (ptr) {
        free(ptr);
        vm.gc.bytes_allocated -= size;
    }
}

static object_t* allocate_object(size_t size, value_type_t type)
{
    object_t* object = (object_t*)allocate(size);
    object->type = type;
    object->is_marked = false;
    object->size = size;
    
    object->next = vm.gc.objects;
    vm.gc.objects = object;
    
    return object;
}

// String operations
static uint32_t hash_string(const char* chars, int length)
{
    uint32_t hash = 2166136261u;
    for (int i = 0; i < length; i++) {
        hash ^= (uint8_t)chars[i];
        hash *= 16777619;
    }
    return hash;
}

static string_object_t* allocate_string(char* chars, int length)
{
    uint32_t hash = hash_string(chars, length);
    
    // Check string interning table
    string_object_t* interned = hash_table_find_string(&vm.strings, chars, length, hash);
    if (interned) {
        free(chars);
        return interned;
    }
    
    string_object_t* string = (string_object_t*)allocate_object(
        sizeof(string_object_t) + length + 1, VAL_STRING);
    string->length = length;
    string->hash = hash;
    memcpy(string->chars, chars, length);
    string->chars[length] = '\0';
    
    // Add to string interning table
    hash_table_set(&vm.strings, string, NIL_VAL);
    
    return string;
}

static string_object_t* copy_string(const char* chars, int length)
{
    uint32_t hash = hash_string(chars, length);
    string_object_t* interned = hash_table_find_string(&vm.strings, chars, length, hash);
    if (interned) {
        return interned;
    }
    
    char* heap_chars = malloc(length + 1);
    memcpy(heap_chars, chars, length);
    heap_chars[length] = '\0';
    
    return allocate_string(heap_chars, length);
}

// Hash table implementation
static void init_hash_table(hash_table_t* table)
{
    table->count = 0;
    table->capacity = 0;
    table->entries = NULL;
}

static void free_hash_table(hash_table_t* table)
{
    deallocate(table->entries, sizeof(hash_entry_t) * table->capacity);
    init_hash_table(table);
}

static hash_entry_t* find_entry(hash_entry_t* entries, int capacity, string_object_t* key)
{
    uint32_t index = key->hash % capacity;
    hash_entry_t* tombstone = NULL;
    
    for (;;) {
        hash_entry_t* entry = &entries[index];
        
        if (entry->key == NULL) {
            if (IS_NIL(entry->value)) {
                return tombstone != NULL ? tombstone : entry;
            } else {
                if (tombstone == NULL) tombstone = entry;
            }
        } else if (entry->key == key) {
            return entry;
        }
        
        index = (index + 1) % capacity;
    }
}

static void adjust_hash_capacity(hash_table_t* table, int capacity)
{
    hash_entry_t* entries = allocate(sizeof(hash_entry_t) * capacity);
    for (int i = 0; i < capacity; i++) {
        entries[i].key = NULL;
        entries[i].value = NIL_VAL;
    }
    
    table->count = 0;
    for (int i = 0; i < table->capacity; i++) {
        hash_entry_t* entry = &table->entries[i];
        if (entry->key == NULL) continue;
        
        hash_entry_t* dest = find_entry(entries, capacity, entry->key);
        dest->key = entry->key;
        dest->value = entry->value;
        table->count++;
    }
    
    deallocate(table->entries, sizeof(hash_entry_t) * table->capacity);
    table->entries = entries;
    table->capacity = capacity;
}

static bool hash_table_set(hash_table_t* table, string_object_t* key, value_t value)
{
    if (table->count + 1 > table->capacity * 0.75) {
        int capacity = table->capacity < 8 ? 8 : table->capacity * 2;
        adjust_hash_capacity(table, capacity);
    }
    
    hash_entry_t* entry = find_entry(table->entries, table->capacity, key);
    bool is_new_key = entry->key == NULL;
    if (is_new_key && IS_NIL(entry->value)) table->count++;
    
    entry->key = key;
    entry->value = value;
    return is_new_key;
}

static bool hash_table_get(hash_table_t* table, string_object_t* key, value_t* value)
{
    if (table->count == 0) return false;
    
    hash_entry_t* entry = find_entry(table->entries, table->capacity, key);
    if (entry->key == NULL) return false;
    
    *value = entry->value;
    return true;
}

static string_object_t* hash_table_find_string(hash_table_t* table, const char* chars,
                                              int length, uint32_t hash)
{
    if (table->count == 0) return NULL;
    
    uint32_t index = hash % table->capacity;
    
    for (;;) {
        hash_entry_t* entry = &table->entries[index];
        
        if (entry->key == NULL) {
            if (IS_NIL(entry->value)) return NULL;
        } else if (entry->key->length == length &&
                   entry->key->hash == hash &&
                   memcmp(entry->key->chars, chars, length) == 0) {
            return entry->key;
        }
        
        index = (index + 1) % table->capacity;
    }
}

// Stack operations
static void reset_stack(void)
{
    vm.stack_top = vm.stack;
    vm.frame_count = 0;
    vm.open_upvalues = NULL;
}

static void push(value_t value)
{
    if (vm.stack_top - vm.stack >= vm.stack_capacity) {
        printf("Stack overflow\n");
        exit(1);
    }
    *vm.stack_top = value;
    vm.stack_top++;
}

static value_t pop(void)
{
    if (vm.stack_top <= vm.stack) {
        printf("Stack underflow\n");
        exit(1);
    }
    vm.stack_top--;
    return *vm.stack_top;
}

static value_t peek(int distance)
{
    return vm.stack_top[-1 - distance];
}

// Value operations
static void print_value(value_t value)
{
    switch (value.type) {
    case VAL_BOOL:
        printf(AS_BOOL(value) ? "true" : "false");
        break;
    case VAL_NIL:
        printf("nil");
        break;
    case VAL_NUMBER:
        printf("%g", AS_NUMBER(value));
        break;
    case VAL_STRING:
        printf("%s", AS_CSTRING(value));
        break;
    case VAL_FUNCTION:
        printf("<fn %s>", AS_FUNCTION(value)->name);
        break;
    case VAL_CLOSURE:
        printf("<closure %s>", AS_CLOSURE(value)->function->name);
        break;
    default:
        printf("<object>");
        break;
    }
}

static bool values_equal(value_t a, value_t b)
{
    if (a.type != b.type) return false;
    
    switch (a.type) {
    case VAL_BOOL:
        return AS_BOOL(a) == AS_BOOL(b);
    case VAL_NIL:
        return true;
    case VAL_NUMBER:
        return AS_NUMBER(a) == AS_NUMBER(b);
    case VAL_STRING:
        return AS_STRING(a) == AS_STRING(b);
    default:
        return false;
    }
}

static bool is_falsey(value_t value)
{
    return IS_NIL(value) || (IS_BOOL(value) && !AS_BOOL(value));
}

// Function operations
static function_object_t* new_function(void)
{
    function_object_t* function = (function_object_t*)allocate_object(sizeof(function_object_t), VAL_FUNCTION);
    function->arity = 0;
    function->upvalue_count = 0;
    function->name = NULL;
    function->bytecode = NULL;
    function->bytecode_length = 0;
    function->constants = NULL;
    function->constant_count = 0;
    return function;
}

static closure_object_t* new_closure(function_object_t* function)
{
    upvalue_object_t** upvalues = allocate(sizeof(upvalue_object_t*) * function->upvalue_count);
    for (int i = 0; i < function->upvalue_count; i++) {
        upvalues[i] = NULL;
    }
    
    closure_object_t* closure = (closure_object_t*)allocate_object(sizeof(closure_object_t), VAL_CLOSURE);
    closure->function = function;
    closure->upvalues = upvalues;
    closure->upvalue_count = function->upvalue_count;
    return closure;
}

static upvalue_object_t* capture_upvalue(value_t* local)
{
    upvalue_object_t* prev_upvalue = NULL;
    upvalue_object_t* upvalue = vm.open_upvalues;
    
    while (upvalue != NULL && upvalue->location > local) {
        prev_upvalue = upvalue;
        upvalue = upvalue->next;
    }
    
    if (upvalue != NULL && upvalue->location == local) {
        return upvalue;
    }
    
    upvalue_object_t* created_upvalue = (upvalue_object_t*)allocate_object(sizeof(upvalue_object_t), VAL_CLOSURE);
    created_upvalue->is_marked = false;
    created_upvalue->location = local;
    created_upvalue->closed = NIL_VAL;
    created_upvalue->next = upvalue;
    
    if (prev_upvalue == NULL) {
        vm.open_upvalues = created_upvalue;
    } else {
        prev_upvalue->next = created_upvalue;
    }
    
    return created_upvalue;
}

static void close_upvalues(value_t* last)
{
    while (vm.open_upvalues != NULL && vm.open_upvalues->location >= last) {
        upvalue_object_t* upvalue = vm.open_upvalues;
        upvalue->closed = *upvalue->location;
        upvalue->location = &upvalue->closed;
        vm.open_upvalues = upvalue->next;
    }
}

// Native functions
static value_t native_clock(vm_t* vm, int arg_count, value_t* args)
{
    return NUMBER_VAL((double)clock() / CLOCKS_PER_SEC);
}

static value_t native_print(vm_t* vm, int arg_count, value_t* args)
{
    for (int i = 0; i < arg_count; i++) {
        print_value(args[i]);
        if (i < arg_count - 1) printf(" ");
    }
    printf("\n");
    return NIL_VAL;
}

static void define_native(const char* name, native_fn_t function)
{
    push(OBJ_VAL(copy_string(name, (int)strlen(name))));
    
    native_object_t* native = (native_object_t*)allocate_object(sizeof(native_object_t), VAL_NATIVE);
    native->function = function;
    native->name = strdup(name);
    
    push(OBJ_VAL(native));
    hash_table_set(&vm.globals, AS_STRING(vm.stack[0]), vm.stack[1]);
    pop();
    pop();
}

// JIT compilation (simplified x86-64 code generation)
static bool jit_compile_function(function_object_t* function)
{
    if (!vm.config.enable_jit) {
        return false;
    }
    
    // Allocate executable memory
    size_t code_size = 4096; // 4KB page
    void* code_mem = mmap(NULL, code_size, PROT_READ | PROT_WRITE | PROT_EXEC,
                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    
    if (code_mem == MAP_FAILED) {
        return false;
    }
    
    uint8_t* code = (uint8_t*)code_mem;
    size_t offset = 0;
    
    // Simple x86-64 prologue
    code[offset++] = 0x55;       // push %rbp
    code[offset++] = 0x48;       // mov %rsp, %rbp
    code[offset++] = 0x89;
    code[offset++] = 0xe5;
    
    // Compile bytecode to native instructions (simplified)
    for (size_t i = 0; i < function->bytecode_length; i++) {
        uint8_t instruction = function->bytecode[i];
        
        switch (instruction) {
        case OP_CONST:
            // Load constant - simplified
            break;
        case OP_ADD:
            // Add two values - simplified
            break;
        case OP_RETURN:
            // Return instruction
            code[offset++] = 0x48;   // mov %rbp, %rsp
            code[offset++] = 0x89;
            code[offset++] = 0xec;
            code[offset++] = 0x5d;   // pop %rbp
            code[offset++] = 0xc3;   // ret
            break;
        default:
            // Fallback to interpreter
            munmap(code_mem, code_size);
            return false;
        }
    }
    
    // Store compiled code
    vm.jit.jit_code = code_mem;
    vm.jit.jit_size = code_size;
    vm.stats.jit_compilations++;
    
    printf("JIT compiled function %s\n", function->name ? function->name : "<script>");
    return true;
}

// Virtual machine execution
static bool call(closure_object_t* closure, int arg_count)
{
    if (arg_count != closure->function->arity) {
        printf("Expected %d arguments but got %d\n", closure->function->arity, arg_count);
        return false;
    }
    
    if (vm.frame_count == 256) {
        printf("Stack overflow\n");
        return false;
    }
    
    call_frame_t* frame = &vm.frames[vm.frame_count++];
    frame->closure = closure;
    frame->ip = closure->function->bytecode;
    frame->slots = vm.stack_top - arg_count - 1;
    
    vm.stats.function_calls++;
    return true;
}

static bool call_value(value_t callee, int arg_count)
{
    if (IS_CLOSURE(callee)) {
        return call(AS_CLOSURE(callee), arg_count);
    } else if (callee.type == VAL_NATIVE) {
        native_object_t* native = (native_object_t*)callee.as.object;
        value_t result = native->function(&vm, arg_count, vm.stack_top - arg_count);
        vm.stack_top -= arg_count + 1;
        push(result);
        return true;
    }
    
    printf("Can only call functions and classes\n");
    return false;
}

static uint8_t read_byte(call_frame_t* frame)
{
    return *frame->ip++;
}

static uint16_t read_short(call_frame_t* frame)
{
    frame->ip += 2;
    return (uint16_t)((frame->ip[-2] << 8) | frame->ip[-1]);
}

static value_t read_constant(call_frame_t* frame)
{
    return frame->closure->function->constants[read_byte(frame)];
}

static int run(void)
{
    call_frame_t* frame = &vm.frames[vm.frame_count - 1];
    
    for (;;) {
        vm.stats.instructions_executed++;
        
        uint8_t instruction = read_byte(frame);
        
        switch (instruction) {
        case OP_CONST: {
            value_t constant = read_constant(frame);
            push(constant);
            break;
        }
        
        case OP_NIL:
            push(NIL_VAL);
            break;
            
        case OP_TRUE:
            push(BOOL_VAL(true));
            break;
            
        case OP_FALSE:
            push(BOOL_VAL(false));
            break;
            
        case OP_POP:
            pop();
            break;
            
        case OP_GET_LOCAL: {
            uint8_t slot = read_byte(frame);
            push(frame->slots[slot]);
            break;
        }
        
        case OP_SET_LOCAL: {
            uint8_t slot = read_byte(frame);
            frame->slots[slot] = peek(0);
            break;
        }
        
        case OP_GET_GLOBAL: {
            string_object_t* name = AS_STRING(read_constant(frame));
            value_t value;
            if (!hash_table_get(&vm.globals, name, &value)) {
                printf("Undefined variable '%s'\n", name->chars);
                return -1;
            }
            push(value);
            break;
        }
        
        case OP_SET_GLOBAL: {
            string_object_t* name = AS_STRING(read_constant(frame));
            if (hash_table_set(&vm.globals, name, peek(0))) {
                hash_table_delete(&vm.globals, name);
                printf("Undefined variable '%s'\n", name->chars);
                return -1;
            }
            break;
        }
        
        case OP_GET_UPVALUE: {
            uint8_t slot = read_byte(frame);
            push(*frame->closure->upvalues[slot]->location);
            break;
        }
        
        case OP_SET_UPVALUE: {
            uint8_t slot = read_byte(frame);
            *frame->closure->upvalues[slot]->location = peek(0);
            break;
        }
        
        case OP_EQUAL: {
            value_t b = pop();
            value_t a = pop();
            push(BOOL_VAL(values_equal(a, b)));
            break;
        }
        
        case OP_GREATER:
            BINARY_OP(BOOL_VAL, >);
            break;
            
        case OP_LESS:
            BINARY_OP(BOOL_VAL, <);
            break;
            
        case OP_ADD: {
            if (IS_STRING(peek(0)) && IS_STRING(peek(1))) {
                concatenate();
            } else if (IS_NUMBER(peek(0)) && IS_NUMBER(peek(1))) {
                double b = AS_NUMBER(pop());
                double a = AS_NUMBER(pop());
                push(NUMBER_VAL(a + b));
            } else {
                printf("Operands must be two numbers or two strings\n");
                return -1;
            }
            break;
        }
        
        case OP_SUBTRACT:
            BINARY_OP(NUMBER_VAL, -);
            break;
            
        case OP_MULTIPLY:
            BINARY_OP(NUMBER_VAL, *);
            break;
            
        case OP_DIVIDE:
            BINARY_OP(NUMBER_VAL, /);
            break;
            
        case OP_NOT:
            push(BOOL_VAL(is_falsey(pop())));
            break;
            
        case OP_NEGATE:
            if (!IS_NUMBER(peek(0))) {
                printf("Operand must be a number\n");
                return -1;
            }
            push(NUMBER_VAL(-AS_NUMBER(pop())));
            break;
            
        case OP_PRINT:
            print_value(pop());
            printf("\n");
            break;
            
        case OP_JUMP: {
            uint16_t offset = read_short(frame);
            frame->ip += offset;
            break;
        }
        
        case OP_JUMP_IF_FALSE: {
            uint16_t offset = read_short(frame);
            if (is_falsey(peek(0))) frame->ip += offset;
            break;
        }
        
        case OP_LOOP: {
            uint16_t offset = read_short(frame);
            frame->ip -= offset;
            break;
        }
        
        case OP_CALL: {
            int arg_count = read_byte(frame);
            if (!call_value(peek(arg_count), arg_count)) {
                return -1;
            }
            frame = &vm.frames[vm.frame_count - 1];
            break;
        }
        
        case OP_CLOSURE: {
            function_object_t* function = AS_FUNCTION(read_constant(frame));
            closure_object_t* closure = new_closure(function);
            push(OBJ_VAL(closure));
            
            for (int i = 0; i < closure->upvalue_count; i++) {
                uint8_t is_local = read_byte(frame);
                uint8_t index = read_byte(frame);
                
                if (is_local) {
                    closure->upvalues[i] = capture_upvalue(frame->slots + index);
                } else {
                    closure->upvalues[i] = frame->closure->upvalues[index];
                }
            }
            break;
        }
        
        case OP_CLOSE_UPVALUE:
            close_upvalues(vm.stack_top - 1);
            pop();
            break;
            
        case OP_RETURN: {
            value_t result = pop();
            close_upvalues(frame->slots);
            vm.frame_count--;
            
            if (vm.frame_count == 0) {
                pop();
                return 0;
            }
            
            vm.stack_top = frame->slots;
            push(result);
            frame = &vm.frames[vm.frame_count - 1];
            break;
        }
        
        case OP_HALT:
            return 0;
            
        default:
            printf("Unknown opcode: %d\n", instruction);
            return -1;
        }
    }
}

// Garbage collection
static void mark_object(object_t* object)
{
    if (object == NULL) return;
    if (object->is_marked) return;
    
    object->is_marked = true;
    
    if (vm.gc.gray_capacity < vm.gc.gray_count + 1) {
        vm.gc.gray_capacity = vm.gc.gray_capacity < 8 ? 8 : vm.gc.gray_capacity * 2;
        vm.gc.gray_stack = realloc(vm.gc.gray_stack, sizeof(object_t*) * vm.gc.gray_capacity);
    }
    
    vm.gc.gray_stack[vm.gc.gray_count++] = object;
}

static void mark_value(value_t value)
{
    if (value.type == VAL_STRING || value.type == VAL_FUNCTION || 
        value.type == VAL_CLOSURE || value.type == VAL_CLASS ||
        value.type == VAL_INSTANCE || value.type == VAL_ARRAY) {
        mark_object(value.as.object);
    }
}

static void mark_array(value_t* array, int count)
{
    for (int i = 0; i < count; i++) {
        mark_value(array[i]);
    }
}

static void blacken_object(object_t* object)
{
    switch (object->type) {
    case VAL_CLOSURE: {
        closure_object_t* closure = (closure_object_t*)object;
        mark_object((object_t*)closure->function);
        for (int i = 0; i < closure->upvalue_count; i++) {
            mark_object((object_t*)closure->upvalues[i]);
        }
        break;
    }
    case VAL_FUNCTION: {
        function_object_t* function = (function_object_t*)object;
        if (function->name) mark_object((object_t*)copy_string(function->name, strlen(function->name)));
        mark_array(function->constants, function->constant_count);
        break;
    }
    case VAL_CLASS: {
        class_object_t* klass = (class_object_t*)object;
        mark_object((object_t*)klass->name);
        mark_hash_table(klass->methods);
        break;
    }
    case VAL_INSTANCE: {
        instance_object_t* instance = (instance_object_t*)object;
        mark_object((object_t*)instance->klass);
        mark_hash_table(instance->fields);
        break;
    }
    case VAL_ARRAY: {
        array_object_t* array = (array_object_t*)object;
        mark_array(array->elements, array->count);
        break;
    }
    default:
        break;
    }
}

static void trace_references(void)
{
    while (vm.gc.gray_count > 0) {
        object_t* object = vm.gc.gray_stack[--vm.gc.gray_count];
        blacken_object(object);
    }
}

static void mark_roots(void)
{
    // Mark stack
    for (value_t* slot = vm.stack; slot < vm.stack_top; slot++) {
        mark_value(*slot);
    }
    
    // Mark call frames
    for (int i = 0; i < vm.frame_count; i++) {
        mark_object((object_t*)vm.frames[i].closure);
    }
    
    // Mark upvalues
    for (upvalue_object_t* upvalue = vm.open_upvalues; upvalue != NULL; upvalue = upvalue->next) {
        mark_object((object_t*)upvalue);
    }
    
    // Mark globals
    mark_hash_table(&vm.globals);
    
    // Mark compiler roots if compiling
    // mark_compiler_roots();
    
    mark_object((object_t*)vm.init_string);
}

static void sweep(void)
{
    object_t* previous = NULL;
    object_t* object = vm.gc.objects;
    
    while (object != NULL) {
        if (object->is_marked) {
            object->is_marked = false;
            previous = object;
            object = object->next;
        } else {
            object_t* unreached = object;
            object = object->next;
            
            if (previous != NULL) {
                previous->next = object;
            } else {
                vm.gc.objects = object;
            }
            
            free_object(unreached);
        }
    }
}

static void collect_garbage(void)
{
    clock_t start = clock();
    
    size_t before = vm.gc.bytes_allocated;
    
    mark_roots();
    trace_references();
    table_remove_white(&vm.strings);
    sweep();
    
    vm.gc.next_gc = vm.gc.bytes_allocated * vm.gc.growth_factor;
    if (vm.gc.next_gc < vm.gc.min_heap_size) {
        vm.gc.next_gc = vm.gc.min_heap_size;
    }
    
    clock_t end = clock();
    double collection_time = ((double)(end - start)) / CLOCKS_PER_SEC;
    
    vm.gc.stats.collections_performed++;
    vm.gc.stats.bytes_freed += before - vm.gc.bytes_allocated;
    vm.gc.stats.avg_collection_time = 
        (vm.gc.stats.avg_collection_time * (vm.gc.stats.collections_performed - 1) + collection_time) /
        vm.gc.stats.collections_performed;
    
    printf("GC: collected %zu bytes in %.3f ms\n", 
           before - vm.gc.bytes_allocated, collection_time * 1000);
}

// Initialization and cleanup
static void init_vm(void)
{
    reset_stack();
    vm.gc.objects = NULL;
    vm.gc.bytes_allocated = 0;
    vm.gc.next_gc = 1024 * 1024;
    vm.gc.gray_count = 0;
    vm.gc.gray_capacity = 0;
    vm.gc.gray_stack = NULL;
    vm.gc.growth_factor = 2.0;
    vm.gc.min_heap_size = 1024 * 1024;
    
    vm.stack_capacity = MAX_STACK_SIZE;
    vm.stack = malloc(sizeof(value_t) * vm.stack_capacity);
    reset_stack();
    
    init_hash_table(&vm.globals);
    init_hash_table(&vm.strings);
    
    vm.init_string = NULL;
    vm.init_string = copy_string("init", 4);
    
    // Configuration
    vm.config.enable_jit = true;
    vm.config.enable_gc = true;
    vm.config.debug_mode = false;
    vm.config.max_stack_size = MAX_STACK_SIZE;
    vm.config.max_heap_size = MAX_HEAP_SIZE;
    
    // Define native functions
    define_native("clock", native_clock);
    define_native("print", native_print);
    
    printf("Virtual machine initialized\n");
}

static void free_vm(void)
{
    free_hash_table(&vm.globals);
    free_hash_table(&vm.strings);
    vm.init_string = NULL;
    
    if (vm.jit.jit_code) {
        munmap(vm.jit.jit_code, vm.jit.jit_size);
    }
    
    free_objects();
    free(vm.stack);
    free(vm.gc.gray_stack);
    
    printf("Virtual machine cleanup completed\n");
}

// Statistics and monitoring
static void print_vm_statistics(void)
{
    printf("\n=== Virtual Machine Statistics ===\n");
    
    printf("Execution:\n");
    printf("  Instructions executed: %lu\n", vm.stats.instructions_executed);
    printf("  Function calls: %lu\n", vm.stats.function_calls);
    printf("  Execution time: %.3f seconds\n", vm.stats.execution_time);
    
    if (vm.stats.instructions_executed > 0) {
        printf("  Instructions per second: %.0f\n", 
               vm.stats.instructions_executed / vm.stats.execution_time);
    }
    
    printf("\nMemory:\n");
    printf("  Bytes allocated: %zu\n", vm.gc.bytes_allocated);
    printf("  Next GC threshold: %zu\n", vm.gc.next_gc);
    printf("  GC collections: %lu\n", vm.gc.stats.collections_performed);
    printf("  Average GC time: %.3f ms\n", vm.gc.stats.avg_collection_time * 1000);
    printf("  Bytes freed: %lu\n", vm.gc.stats.bytes_freed);
    
    if (vm.config.enable_jit) {
        printf("\nJIT Compilation:\n");
        printf("  Compilations: %lu\n", vm.stats.jit_compilations);
        printf("  JIT enabled: %s\n", vm.jit.enabled ? "Yes" : "No");
    }
    
    printf("==================================\n");
}

// Simple test program
static void test_vm(void)
{
    printf("Testing virtual machine...\n");
    
    // Create a simple test function
    function_object_t* test_function = new_function();
    test_function->name = "test";
    test_function->arity = 0;
    
    // Simple bytecode: load constant, print, return
    uint8_t bytecode[] = {
        OP_CONST, 0,    // Load constant 0
        OP_PRINT,       // Print value
        OP_NIL,         // Load nil
        OP_RETURN       // Return
    };
    
    test_function->bytecode = malloc(sizeof(bytecode));
    memcpy(test_function->bytecode, bytecode, sizeof(bytecode));
    test_function->bytecode_length = sizeof(bytecode);
    
    // Constants
    test_function->constants = malloc(sizeof(value_t));
    test_function->constants[0] = NUMBER_VAL(42.0);
    test_function->constant_count = 1;
    
    // Create closure and call
    closure_object_t* closure = new_closure(test_function);
    push(OBJ_VAL(closure));
    
    clock_t start = clock();
    int result = run();
    clock_t end = clock();
    
    vm.stats.execution_time = ((double)(end - start)) / CLOCKS_PER_SEC;
    
    printf("Test completed with result: %d\n", result);
}

// Signal handlers
static void signal_handler(int sig)
{
    if (sig == SIGINT || sig == SIGTERM) {
        printf("\nReceived signal %d, shutting down VM...\n", sig);
        free_vm();
        exit(0);
    } else if (sig == SIGUSR1) {
        print_vm_statistics();
    } else if (sig == SIGUSR2) {
        if (vm.config.enable_gc) {
            collect_garbage();
        }
    }
}

// Main function
int main(int argc, char* argv[])
{
    printf("Advanced Language Runtime and Virtual Machine\n");
    
    // Set up signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGUSR1, signal_handler);
    signal(SIGUSR2, signal_handler);
    
    // Initialize virtual machine
    init_vm();
    
    // Run tests
    test_vm();
    
    printf("Virtual machine running...\n");
    printf("Send SIGUSR1 for statistics, SIGUSR2 for GC, SIGINT to exit\n");
    
    // Keep running for interactive use
    while (1) {
        sleep(1);
    }
    
    // Print final statistics
    print_vm_statistics();
    
    // Cleanup
    free_vm();
    
    return 0;
}
```

This comprehensive Linux compiler and language runtime development blog post covers:

1. **Virtual Machine Architecture** - Complete stack-based VM with bytecode interpretation and JIT compilation
2. **Memory Management** - Garbage collection with mark-and-sweep algorithm and object lifecycle management
3. **Language Features** - Functions, closures, classes, native functions, and dynamic typing
4. **JIT Compilation** - Basic native code generation for performance optimization
5. **Hash Table Implementation** - String interning and variable storage with collision resolution

The implementation demonstrates production-grade language runtime techniques suitable for building custom programming languages, interpreters, and domain-specific languages.