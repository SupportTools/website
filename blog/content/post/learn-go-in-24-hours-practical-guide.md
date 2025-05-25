---
title: "Learn Go in 24 Hours: A Practical Guide to Mastering the Basics"
date: 2027-01-28T09:00:00-05:00
draft: false
tags: ["go", "golang", "programming", "learning", "tutorial"]
categories: ["Programming", "Go"]
---

Go (or Golang) has rapidly become one of the most sought-after programming languages for backend development, cloud infrastructure, and DevOps. Its simplicity, strong standard library, built-in concurrency, and excellent performance make it an attractive choice for both newcomers and experienced developers. This article offers a structured 24-hour plan to learn Go's fundamentals, broken down into manageable sessions with practical exercises and code examples.

## Hour 1-2: Setting Up and First Steps

### Installation and Setup

Start by installing Go on your system:

```bash
# For Linux (using apt)
sudo apt-get update
sudo apt-get install golang-go

# For macOS (using Homebrew)
brew install go

# For Windows
# Download installer from https://golang.org/dl/
```

Verify your installation:

```bash
go version
```

Set up your Go workspace:

```bash
mkdir -p ~/go/{bin,pkg,src}
```

Add the following to your `.bashrc`, `.zshrc`, or appropriate shell configuration file:

```bash
export GOPATH=$HOME/go
export PATH=$PATH:$GOPATH/bin
```

### Your First Go Program

Create a file named `hello.go`:

```go
package main

import "fmt"

func main() {
    fmt.Println("Hello, Go world!")
}
```

Run it:

```bash
go run hello.go
```

Build it:

```bash
go build hello.go
./hello
```

## Hour 3-4: Basic Syntax and Data Types

### Variables and Types

Go has several basic types:

```go
package main

import "fmt"

func main() {
    // Variable declarations
    var name string = "Go Developer"
    age := 25 // Short variable declaration with type inference
    
    // Basic types
    var isGoProgrammer bool = true
    var counter int = 42
    var pi float64 = 3.14159
    
    // Multiple variable declaration
    var (
        language = "Go"
        version  = 1.21
        isStable = true
    )
    
    fmt.Println(name, age, isGoProgrammer, counter, pi)
    fmt.Println(language, version, isStable)
    
    // Constants
    const MaxConnections = 100
    const (
        StatusOK       = 200
        StatusNotFound = 404
    )
    
    fmt.Println(MaxConnections, StatusOK, StatusNotFound)
}
```

### Control Structures

```go
package main

import "fmt"

func main() {
    // If-else
    age := 18
    if age >= 18 {
        fmt.Println("Adult")
    } else {
        fmt.Println("Minor")
    }
    
    // If with short statement
    if score := 85; score >= 70 {
        fmt.Println("Passed with score:", score)
    }
    
    // For loop (standard)
    for i := 0; i < 5; i++ {
        fmt.Println("Iteration:", i)
    }
    
    // For as a while loop
    counter := 0
    for counter < 3 {
        fmt.Println("Counter:", counter)
        counter++
    }
    
    // Infinite loop with break
    sum := 0
    for {
        sum++
        if sum > 10 {
            break
        }
    }
    fmt.Println("Sum:", sum)
    
    // Switch statement
    day := "Monday"
    switch day {
    case "Monday":
        fmt.Println("Start of work week")
    case "Friday":
        fmt.Println("End of work week")
    default:
        fmt.Println("Regular day")
    }
    
    // Switch with no expression (like if-else chains)
    switch {
    case age < 13:
        fmt.Println("Child")
    case age < 20:
        fmt.Println("Teenager")
    default:
        fmt.Println("Adult")
    }
}
```

## Hour 5-6: Composite Types

### Arrays and Slices

```go
package main

import "fmt"

func main() {
    // Arrays - fixed size
    var numbers [5]int = [5]int{1, 2, 3, 4, 5}
    fmt.Println("Array:", numbers)
    
    // Short declaration
    names := [3]string{"Alice", "Bob", "Charlie"}
    fmt.Println("Names:", names)
    
    // Array with size determined by the initializer
    days := [...]string{"Mon", "Tue", "Wed", "Thu", "Fri"}
    fmt.Println("Days:", days, "Length:", len(days))
    
    // Slices - dynamic size views of arrays
    var scores []int = []int{90, 85, 88}
    fmt.Println("Scores:", scores)
    
    // Create slice using make
    queue := make([]string, 0, 10) // len=0, cap=10
    queue = append(queue, "First")
    queue = append(queue, "Second")
    fmt.Println("Queue:", queue, "Length:", len(queue), "Capacity:", cap(queue))
    
    // Slice operations
    fruits := []string{"Apple", "Banana", "Cherry", "Date", "Elderberry"}
    fmt.Println("Fruits:", fruits)
    
    // Slicing
    someFruits := fruits[1:4] // [Banana, Cherry, Date]
    fmt.Println("Some fruits:", someFruits)
    
    // Slicing with default indices
    fromStart := fruits[:3] // [Apple, Banana, Cherry]
    toEnd := fruits[2:]     // [Cherry, Date, Elderberry]
    fmt.Println("From start:", fromStart)
    fmt.Println("To end:", toEnd)
    
    // Creating a slice by appending to nil
    var cities []string
    cities = append(cities, "New York", "London", "Tokyo")
    fmt.Println("Cities:", cities)
}
```

### Maps

```go
package main

import "fmt"

func main() {
    // Declare and initialize a map
    var userAges map[string]int = map[string]int{
        "Alice": 30,
        "Bob":   25,
        "Carol": 27,
    }
    fmt.Println("User ages:", userAges)
    
    // Short declaration
    countryCapitals := map[string]string{
        "USA":     "Washington D.C.",
        "UK":      "London",
        "Germany": "Berlin",
        "Japan":   "Tokyo",
    }
    fmt.Println("Country capitals:", countryCapitals)
    
    // Create map using make
    studentGrades := make(map[string]float64)
    studentGrades["John"] = 3.8
    studentGrades["Emma"] = 4.0
    fmt.Println("Student grades:", studentGrades)
    
    // Check if key exists
    capital, exists := countryCapitals["France"]
    if exists {
        fmt.Println("Capital of France:", capital)
    } else {
        fmt.Println("France not found in the map")
    }
    
    // Delete a key
    delete(userAges, "Bob")
    fmt.Println("After deletion:", userAges)
    
    // Iterating over a map
    fmt.Println("Country capitals:")
    for country, capital := range countryCapitals {
        fmt.Printf("%s: %s\n", country, capital)
    }
}
```

### Structs

```go
package main

import "fmt"

// Define a struct
type Person struct {
    Name    string
    Age     int
    Address Address
}

type Address struct {
    Street  string
    City    string
    Country string
}

func main() {
    // Initialize struct
    bob := Person{
        Name: "Bob Smith",
        Age:  35,
        Address: Address{
            Street:  "123 Main St",
            City:    "New York",
            Country: "USA",
        },
    }
    fmt.Println("Person:", bob)
    
    // Access fields
    fmt.Println("Name:", bob.Name)
    fmt.Println("City:", bob.Address.City)
    
    // Partially initialize a struct
    alice := Person{Name: "Alice Johnson"}
    fmt.Println("Alice:", alice) // Age and Address have zero values
    
    // Pointers to structs
    bobPointer := &Person{Name: "Bob Pointer", Age: 42}
    fmt.Println("Via pointer:", bobPointer.Name) // Syntactic sugar for (*bobPointer).Name
    
    // Anonymous structs
    employee := struct {
        ID     int
        Role   string
        Active bool
    }{
        ID:     1001,
        Role:   "Developer",
        Active: true,
    }
    fmt.Println("Employee:", employee)
}
```

## Hour 7-8: Functions and Methods

### Functions

```go
package main

import "fmt"

// Basic function
func greet(name string) {
    fmt.Println("Hello,", name)
}

// Function with multiple parameters
func add(a, b int) int {
    return a + b
}

// Function with multiple return values
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("cannot divide by zero")
    }
    return a / b, nil
}

// Named return values
func calculateStats(numbers []int) (min, max, sum int) {
    if len(numbers) == 0 {
        return 0, 0, 0
    }
    
    min = numbers[0]
    max = numbers[0]
    sum = 0
    
    for _, num := range numbers {
        if num < min {
            min = num
        }
        if num > max {
            max = num
        }
        sum += num
    }
    
    return // implicit return of named return values
}

// Variadic function
func sumAll(nums ...int) int {
    total := 0
    for _, num := range nums {
        total += num
    }
    return total
}

func main() {
    // Calling functions
    greet("Gopher")
    
    result := add(5, 7)
    fmt.Println("5 + 7 =", result)
    
    quotient, err := divide(10, 2)
    if err != nil {
        fmt.Println("Error:", err)
    } else {
        fmt.Println("10 / 2 =", quotient)
    }
    
    quotient, err = divide(10, 0)
    if err != nil {
        fmt.Println("Error:", err)
    }
    
    // Using named return values
    min, max, sum := calculateStats([]int{3, 1, 7, 4, 2})
    fmt.Printf("Stats: min=%d, max=%d, sum=%d\n", min, max, sum)
    
    // Variadic function calls
    fmt.Println("Sum:", sumAll(1, 2, 3, 4, 5))
    
    numbers := []int{10, 20, 30, 40}
    fmt.Println("Sum of slice:", sumAll(numbers...)) // Unpack slice
    
    // Anonymous function
    square := func(n int) int {
        return n * n
    }
    fmt.Println("5² =", square(5))
    
    // Immediately invoked function expression (IIFE)
    result = func(x, y int) int {
        return x * y
    }(4, 5)
    fmt.Println("4 * 5 =", result)
}
```

### Methods

```go
package main

import (
    "fmt"
    "math"
)

// Defining a struct type
type Rectangle struct {
    Width  float64
    Height float64
}

// Method with a receiver
func (r Rectangle) Area() float64 {
    return r.Width * r.Height
}

// Method with a pointer receiver (can modify the receiver)
func (r *Rectangle) Scale(factor float64) {
    r.Width *= factor
    r.Height *= factor
}

type Circle struct {
    Radius float64
}

func (c Circle) Area() float64 {
    return math.Pi * c.Radius * c.Radius
}

func (c Circle) Circumference() float64 {
    return 2 * math.Pi * c.Radius
}

type Counter int

func (c *Counter) Increment() {
    *c++
}

func (c Counter) String() string {
    return fmt.Sprintf("Counter: %d", c)
}

func main() {
    // Creating an instance
    rect := Rectangle{Width: 10, Height: 5}
    
    // Calling methods
    fmt.Println("Rectangle area:", rect.Area())
    
    // Method with pointer receiver
    rect.Scale(2) // Go automatically handles &rect.Scale(2)
    fmt.Println("After scaling:", rect)
    fmt.Println("New area:", rect.Area())
    
    // Methods on different types
    circle := Circle{Radius: 5}
    fmt.Printf("Circle: area=%.2f, circumference=%.2f\n", 
               circle.Area(), circle.Circumference())
    
    // Methods on primitive types
    var count Counter = 5
    count.Increment()
    count.Increment()
    fmt.Println(count.String())
}
```

## Hour 9-10: Error Handling and Defer

### Error Handling

```go
package main

import (
    "errors"
    "fmt"
    "io"
    "os"
    "strconv"
)

// Function that returns an error
func divide(a, b int) (int, error) {
    if b == 0 {
        return 0, errors.New("cannot divide by zero")
    }
    return a / b, nil
}

// Custom error type
type ValidationError struct {
    Field string
    Issue string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("validation failed on %s: %s", e.Field, e.Issue)
}

// Function that returns a custom error
func validateAge(age int) error {
    if age < 0 {
        return ValidationError{Field: "age", Issue: "cannot be negative"}
    }
    if age > 150 {
        return ValidationError{Field: "age", Issue: "unrealistically high"}
    }
    return nil
}

func main() {
    // Basic error handling
    result, err := divide(10, 2)
    if err != nil {
        fmt.Println("Error:", err)
    } else {
        fmt.Println("Result:", result)
    }
    
    // Error from stdlib
    n, err := strconv.Atoi("not-a-number")
    if err != nil {
        fmt.Println("Conversion error:", err)
    } else {
        fmt.Println("Converted number:", n)
    }
    
    // Working with files and error handling
    file, err := os.Open("non-existent-file.txt")
    if err != nil {
        fmt.Println("File error:", err)
    } else {
        defer file.Close() // Will learn about defer soon
        data := make([]byte, 100)
        count, err := file.Read(data)
        if err != nil && err != io.EOF {
            fmt.Println("Read error:", err)
        } else {
            fmt.Printf("Read %d bytes: %s\n", count, data[:count])
        }
    }
    
    // Custom error type
    err = validateAge(200)
    if err != nil {
        fmt.Println("Validation error:", err)
        
        // Type assertion to check specific error type
        if validationErr, ok := err.(ValidationError); ok {
            fmt.Printf("Field %s has issue: %s\n", 
                      validationErr.Field, validationErr.Issue)
        }
    }
    
    err = validateAge(-10)
    if err != nil {
        fmt.Println("Validation error:", err)
    }
}
```

### Defer, Panic, and Recover

```go
package main

import (
    "fmt"
    "os"
)

// Function with resource cleanup
func readFile(filename string) (string, error) {
    file, err := os.Open(filename)
    if err != nil {
        return "", err
    }
    defer file.Close() // Ensures file is closed when function returns
    
    // Read file contents
    data := make([]byte, 100)
    count, err := file.Read(data)
    if err != nil {
        return "", err
    }
    
    return string(data[:count]), nil
}

// Function that demonstrates defer order (LIFO)
func deferOrder() {
    fmt.Println("Main function starts")
    
    defer fmt.Println("First defer")
    defer fmt.Println("Second defer")
    defer fmt.Println("Third defer")
    
    fmt.Println("Main function ends")
}

// Function that demonstrates panic and recover
func riskyOperation(shouldPanic bool) {
    // Recover must be called from deferred function
    defer func() {
        if r := recover(); r != nil {
            fmt.Println("Recovered from panic:", r)
        }
    }()
    
    fmt.Println("Performing risky operation")
    if shouldPanic {
        panic("something terrible happened")
    }
    fmt.Println("Risky operation completed successfully")
}

func main() {
    // Using defer for cleanup
    content, err := readFile("example.txt")
    if err != nil {
        fmt.Println("Error reading file:", err)
    } else {
        fmt.Println("File content:", content)
    }
    
    // Demonstrating defer order (last in, first out)
    deferOrder()
    
    // Demonstrating panic and recover
    fmt.Println("\nCalling risky operation (no panic):")
    riskyOperation(false)
    
    fmt.Println("\nCalling risky operation (with panic):")
    riskyOperation(true)
    
    fmt.Println("\nProgram continues after recovering from panic")
}
```

## Hour 11-12: Interfaces and Polymorphism

### Interfaces

```go
package main

import (
    "fmt"
    "math"
)

// Define an interface
type Shape interface {
    Area() float64
    Perimeter() float64
}

// Types implementing the Shape interface
type Rectangle struct {
    Width  float64
    Height float64
}

func (r Rectangle) Area() float64 {
    return r.Width * r.Height
}

func (r Rectangle) Perimeter() float64 {
    return 2 * (r.Width + r.Height)
}

type Circle struct {
    Radius float64
}

func (c Circle) Area() float64 {
    return math.Pi * c.Radius * c.Radius
}

func (c Circle) Perimeter() float64 {
    return 2 * math.Pi * c.Radius
}

// Function that accepts an interface
func printShapeInfo(s Shape) {
    fmt.Printf("Area: %.2f, Perimeter: %.2f\n", s.Area(), s.Perimeter())
}

// Interface composition
type Sized interface {
    Size() int
}

type Documented interface {
    Documentation() string
}

// Composite interface
type SizedAndDocumented interface {
    Sized
    Documented
}

// Implementation of composite interface
type File struct {
    Name string
    Size int
    Docs string
}

func (f File) Size() int {
    return f.Size
}

func (f File) Documentation() string {
    return f.Docs
}

// Empty interface
func describe(i interface{}) {
    fmt.Printf("Type: %T, Value: %v\n", i, i)
}

func main() {
    // Creating shapes
    rect := Rectangle{Width: 5, Height: 10}
    circle := Circle{Radius: 7}
    
    // Using interface method
    printShapeInfo(rect)
    printShapeInfo(circle)
    
    // Slice of interfaces
    shapes := []Shape{rect, circle, Rectangle{Width: 3, Height: 4}}
    for _, shape := range shapes {
        printShapeInfo(shape)
    }
    
    // Type assertions
    var s Shape = Circle{Radius: 5}
    
    c, ok := s.(Circle)
    if ok {
        fmt.Println("Shape is a circle with radius:", c.Radius)
    }
    
    // Type switch
    for _, shape := range shapes {
        switch v := shape.(type) {
        case Rectangle:
            fmt.Printf("Rectangle with width %.2f and height %.2f\n", 
                      v.Width, v.Height)
        case Circle:
            fmt.Printf("Circle with radius %.2f\n", v.Radius)
        default:
            fmt.Println("Unknown shape")
        }
    }
    
    // Empty interface can hold any value
    describe(42)
    describe("Hello")
    describe(true)
    describe([]string{"a", "b", "c"})
}
```

## Hour 13-14: Concurrency with Goroutines and Channels

### Goroutines

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func printNumbers() {
    for i := 1; i <= 5; i++ {
        time.Sleep(100 * time.Millisecond)
        fmt.Printf("%d ", i)
    }
}

func printLetters() {
    for i := 'a'; i <= 'e'; i++ {
        time.Sleep(150 * time.Millisecond)
        fmt.Printf("%c ", i)
    }
}

func main() {
    // Sequential execution
    fmt.Println("Sequential execution:")
    printNumbers()
    fmt.Println()
    printLetters()
    fmt.Println()
    
    // Concurrent execution with goroutines
    fmt.Println("Concurrent execution:")
    go printNumbers()
    go printLetters()
    
    // Sleep to allow goroutines to complete
    // (This is just for demonstration, not a good practice)
    time.Sleep(1 * time.Second)
    fmt.Println("\nDone with basic goroutines")
    
    // Proper synchronization with WaitGroup
    var wg sync.WaitGroup
    
    // Launch 5 goroutines
    for i := 1; i <= 5; i++ {
        wg.Add(1) // Increment counter
        
        // Using a function literal (closure)
        go func(id int) {
            defer wg.Done() // Decrement counter when done
            
            fmt.Printf("Worker %d starting\n", id)
            time.Sleep(time.Duration(id) * 100 * time.Millisecond)
            fmt.Printf("Worker %d done\n", id)
        }(i) // Pass i as an argument to avoid closure issues
    }
    
    fmt.Println("Waiting for all workers to finish...")
    wg.Wait() // Block until counter is zero
    fmt.Println("All workers completed")
}
```

### Channels

```go
package main

import (
    "fmt"
    "time"
)

func worker(id int, jobs <-chan int, results chan<- int) {
    for job := range jobs {
        fmt.Printf("Worker %d started job %d\n", id, job)
        time.Sleep(200 * time.Millisecond) // Simulate work
        fmt.Printf("Worker %d finished job %d\n", id, job)
        results <- job * 2 // Send result back
    }
}

func main() {
    // Basic channel usage
    ch := make(chan string)
    
    go func() {
        fmt.Println("Sending message to channel")
        ch <- "Hello from goroutine!"
    }()
    
    msg := <-ch // Receive from channel
    fmt.Println("Received:", msg)
    
    // Buffered channels
    buffer := make(chan string, 2)
    buffer <- "First message"  // Won't block
    buffer <- "Second message" // Won't block
    
    fmt.Println(<-buffer)
    fmt.Println(<-buffer)
    
    // Worker pool pattern
    numJobs := 5
    jobs := make(chan int, numJobs)
    results := make(chan int, numJobs)
    
    // Start 3 workers
    for w := 1; w <= 3; w++ {
        go worker(w, jobs, results)
    }
    
    // Send jobs
    for j := 1; j <= numJobs; j++ {
        jobs <- j
    }
    close(jobs) // Signal no more jobs
    
    // Collect results
    for i := 1; i <= numJobs; i++ {
        result := <-results
        fmt.Println("Result:", result)
    }
    
    // Channel select statement
    ch1 := make(chan string)
    ch2 := make(chan string)
    
    go func() {
        time.Sleep(100 * time.Millisecond)
        ch1 <- "Channel 1"
    }()
    
    go func() {
        time.Sleep(200 * time.Millisecond)
        ch2 <- "Channel 2"
    }()
    
    // Select between channels
    for i := 0; i < 2; i++ {
        select {
        case msg1 := <-ch1:
            fmt.Println("Received from ch1:", msg1)
        case msg2 := <-ch2:
            fmt.Println("Received from ch2:", msg2)
        case <-time.After(500 * time.Millisecond):
            fmt.Println("Timeout")
        }
    }
}
```

## Hour 15-16: Advanced Concurrency Patterns

### Cancellation and Context

```go
package main

import (
    "context"
    "fmt"
    "time"
)

// Function that respects cancellation
func longOperation(ctx context.Context) {
    // Create a channel for operation completion
    done := make(chan bool)
    
    // Run operation in goroutine
    go func() {
        // Simulate long operation
        fmt.Println("Long operation started")
        time.Sleep(5 * time.Second)
        fmt.Println("Long operation finished")
        done <- true
    }()
    
    // Wait for completion or cancellation
    select {
    case <-done:
        fmt.Println("Operation completed successfully")
    case <-ctx.Done():
        fmt.Println("Operation canceled:", ctx.Err())
    }
}

// Worker that uses context for cancellation
func worker(ctx context.Context, id int) {
    fmt.Printf("Worker %d: started\n", id)
    
    // Listen for cancellation while doing work
    for {
        select {
        case <-ctx.Done():
            fmt.Printf("Worker %d: stopping due to: %v\n", id, ctx.Err())
            return
        default:
            // Simulate work
            fmt.Printf("Worker %d: working...\n", id)
            time.Sleep(500 * time.Millisecond)
        }
    }
}

func main() {
    // Context with cancel
    ctx, cancel := context.WithCancel(context.Background())
    
    // Start operation
    go longOperation(ctx)
    
    // Cancel after 2 seconds
    time.Sleep(2 * time.Second)
    fmt.Println("Canceling operation...")
    cancel()
    
    // Give time to see the cancellation happen
    time.Sleep(1 * time.Second)
    
    fmt.Println("\n--- Context with timeout ---")
    
    // Context with timeout
    timeoutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel() // Always call cancel to release resources
    
    go longOperation(timeoutCtx)
    
    // Wait for operation to complete or timeout
    time.Sleep(3 * time.Second)
    
    fmt.Println("\n--- Context with deadline ---")
    
    // Context with deadline
    deadline := time.Now().Add(1 * time.Second)
    deadlineCtx, cancel := context.WithDeadline(context.Background(), deadline)
    defer cancel()
    
    // Start multiple workers
    for i := 1; i <= 3; i++ {
        go worker(deadlineCtx, i)
    }
    
    // Let workers run for a bit
    time.Sleep(3 * time.Second)
    fmt.Println("Main: all done")
}
```

### Concurrency Patterns

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

// Generator pattern: returns a read-only channel
func generator(nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            out <- n
        }
    }()
    return out
}

// Fan-out pattern: distributes work across multiple goroutines
func square(in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for n := range in {
            time.Sleep(100 * time.Millisecond) // Simulate work
            out <- n * n
        }
    }()
    return out
}

// Fan-in pattern: combines multiple channels into one
func fanIn(cs ...<-chan int) <-chan int {
    var wg sync.WaitGroup
    out := make(chan int)
    
    // Start an output goroutine for each input channel
    output := func(c <-chan int) {
        defer wg.Done()
        for n := range c {
            out <- n
        }
    }
    
    wg.Add(len(cs))
    for _, c := range cs {
        go output(c)
    }
    
    // Start a goroutine to close out when all output goroutines are done
    go func() {
        wg.Wait()
        close(out)
    }()
    
    return out
}

// Pipeline pattern
func pipeline() {
    // Stage 1: Generate numbers
    nums := generator(1, 2, 3, 4, 5)
    
    // Stage 2: Fan out to 3 workers
    sq1 := square(nums)
    sq2 := square(nums)
    sq3 := square(nums)
    
    // Stage 3: Fan in results
    results := fanIn(sq1, sq2, sq3)
    
    // Collect results
    for result := range results {
        fmt.Println("Result:", result)
    }
}

// Rate limiting pattern
func rateLimiting() {
    // Create a limiter that allows bursts of up to 3 events
    limiter := time.Tick(200 * time.Millisecond)
    
    // Process 5 requests
    for i := 1; i <= 5; i++ {
        <-limiter // Rate limit
        fmt.Println("Request", i, "processed at", time.Now().Format("15:04:05.000"))
    }
    
    // Demonstrate bursty rate limiting
    burstLimiter := make(chan time.Time, 3)
    
    // Fill the channel with burst capacity
    for i := 0; i < 3; i++ {
        burstLimiter <- time.Now()
    }
    
    // Replenish at a regular rate
    go func() {
        for t := range time.Tick(500 * time.Millisecond) {
            burstLimiter <- t
        }
    }()
    
    // Process 8 bursty requests
    fmt.Println("\nBursty rate limiting:")
    for i := 1; i <= 8; i++ {
        <-burstLimiter // Rate limit
        fmt.Println("Bursty request", i, "processed at", time.Now().Format("15:04:05.000"))
    }
}

func main() {
    fmt.Println("Running pipeline pattern:")
    pipeline()
    
    fmt.Println("\nRunning rate limiting pattern:")
    rateLimiting()
}
```

## Hour 17-18: Testing and Benchmarking

### Unit Testing

Create a file named `math.go`:

```go
package math

// Add returns the sum of a and b
func Add(a, b int) int {
    return a + b
}

// Subtract returns the difference between a and b
func Subtract(a, b int) int {
    return a - b
}

// Multiply returns the product of a and b
func Multiply(a, b int) int {
    return a * b
}

// Divide returns the quotient of a and b
// Returns 0 if b is 0
func Divide(a, b int) int {
    if b == 0 {
        return 0
    }
    return a / b
}
```

Create a test file named `math_test.go`:

```go
package math

import "testing"

func TestAdd(t *testing.T) {
    // Table-driven test
    tests := []struct {
        name     string
        a, b     int
        expected int
    }{
        {"positive numbers", 2, 3, 5},
        {"negative numbers", -2, -3, -5},
        {"mixed signs", -2, 3, 1},
        {"zeros", 0, 0, 0},
    }
    
    for _, test := range tests {
        t.Run(test.name, func(t *testing.T) {
            result := Add(test.a, test.b)
            if result != test.expected {
                t.Errorf("Add(%d, %d) = %d; expected %d", 
                        test.a, test.b, result, test.expected)
            }
        })
    }
}

func TestSubtract(t *testing.T) {
    result := Subtract(5, 3)
    if result != 2 {
        t.Errorf("Subtract(5, 3) = %d; expected 2", result)
    }
}

func TestMultiply(t *testing.T) {
    result := Multiply(4, 5)
    if result != 20 {
        t.Errorf("Multiply(4, 5) = %d; expected 20", result)
    }
}

func TestDivide(t *testing.T) {
    // Regular division
    result := Divide(10, 2)
    if result != 5 {
        t.Errorf("Divide(10, 2) = %d; expected 5", result)
    }
    
    // Division by zero
    result = Divide(10, 0)
    if result != 0 {
        t.Errorf("Divide(10, 0) = %d; expected 0", result)
    }
}
```

Run the tests:

```bash
go test
```

Run with verbose output:

```bash
go test -v
```

### Benchmarking

Add benchmarks to `math_test.go`:

```go
func BenchmarkAdd(b *testing.B) {
    // Run the Add function b.N times
    for i := 0; i < b.N; i++ {
        Add(4, 5)
    }
}

func BenchmarkSubtract(b *testing.B) {
    for i := 0; i < b.N; i++ {
        Subtract(10, 5)
    }
}

func BenchmarkMultiply(b *testing.B) {
    for i := 0; i < b.N; i++ {
        Multiply(4, 5)
    }
}

func BenchmarkDivide(b *testing.B) {
    for i := 0; i < b.N; i++ {
        Divide(20, 5)
    }
}
```

Run benchmarks:

```bash
go test -bench=.
```

## Hour 19-20: Package Management and Go Modules

### Creating a Module

Initialize a new module:

```bash
mkdir myapp
cd myapp
go mod init github.com/yourusername/myapp
```

Create a simple application in `main.go`:

```go
package main

import (
    "fmt"
    "log"
    "net/http"

    "github.com/gorilla/mux"
)

func main() {
    // Create a new router
    r := mux.NewRouter()
    
    // Define a route handler
    r.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintln(w, "Hello, Go world!")
    })
    
    // Add a parameterized route
    r.HandleFunc("/greet/{name}", func(w http.ResponseWriter, r *http.Request) {
        vars := mux.Vars(r)
        name := vars["name"]
        fmt.Fprintf(w, "Hello, %s!", name)
    })
    
    // Start the server
    fmt.Println("Server starting on :8080")
    log.Fatal(http.ListenAndServe(":8080", r))
}
```

Add the dependency:

```bash
go get github.com/gorilla/mux
```

Run the application:

```bash
go run main.go
```

### Understanding Go Modules

Examine the module files:

```bash
cat go.mod
cat go.sum
```

Update dependencies:

```bash
go get -u
```

Create a versioned module release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Hour 21-22: Building Real-World Applications

### Creating a RESTful API

```go
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "strconv"

    "github.com/gorilla/mux"
)

// Define data model
type Book struct {
    ID     int    `json:"id"`
    Title  string `json:"title"`
    Author string `json:"author"`
    Year   int    `json:"year"`
}

// In-memory database
var books []Book
var nextID = 1

// Initialize with some data
func init() {
    books = append(books, Book{ID: nextID, Title: "The Go Programming Language", Author: "Alan Donovan and Brian Kernighan", Year: 2015})
    nextID++
    books = append(books, Book{ID: nextID, Title: "Concurrency in Go", Author: "Katherine Cox-Buday", Year: 2017})
    nextID++
}

// Handler functions
func getBooks(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(books)
}

func getBook(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    
    // Get ID from URL parameters
    params := mux.Vars(r)
    id, err := strconv.Atoi(params["id"])
    if err != nil {
        http.Error(w, "Invalid ID", http.StatusBadRequest)
        return
    }
    
    // Find book with matching ID
    for _, book := range books {
        if book.ID == id {
            json.NewEncoder(w).Encode(book)
            return
        }
    }
    
    // Book not found
    http.Error(w, "Book not found", http.StatusNotFound)
}

func createBook(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    
    var book Book
    // Decode request body into Book struct
    err := json.NewDecoder(r.Body).Decode(&book)
    if err != nil {
        http.Error(w, "Invalid request body", http.StatusBadRequest)
        return
    }
    
    // Assign new ID
    book.ID = nextID
    nextID++
    
    // Add to database
    books = append(books, book)
    
    // Return created book
    json.NewEncoder(w).Encode(book)
}

func updateBook(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    
    // Get ID from URL parameters
    params := mux.Vars(r)
    id, err := strconv.Atoi(params["id"])
    if err != nil {
        http.Error(w, "Invalid ID", http.StatusBadRequest)
        return
    }
    
    var updatedBook Book
    // Decode request body
    err = json.NewDecoder(r.Body).Decode(&updatedBook)
    if err != nil {
        http.Error(w, "Invalid request body", http.StatusBadRequest)
        return
    }
    
    // Find and update book
    for i, book := range books {
        if book.ID == id {
            // Preserve ID, update other fields
            updatedBook.ID = id
            books[i] = updatedBook
            json.NewEncoder(w).Encode(updatedBook)
            return
        }
    }
    
    // Book not found
    http.Error(w, "Book not found", http.StatusNotFound)
}

func deleteBook(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    
    // Get ID from URL parameters
    params := mux.Vars(r)
    id, err := strconv.Atoi(params["id"])
    if err != nil {
        http.Error(w, "Invalid ID", http.StatusBadRequest)
        return
    }
    
    // Find and remove book
    for i, book := range books {
        if book.ID == id {
            // Remove book from slice
            books = append(books[:i], books[i+1:]...)
            w.WriteHeader(http.StatusNoContent)
            return
        }
    }
    
    // Book not found
    http.Error(w, "Book not found", http.StatusNotFound)
}

func main() {
    // Create router
    r := mux.NewRouter()
    
    // Define API routes
    r.HandleFunc("/books", getBooks).Methods("GET")
    r.HandleFunc("/books/{id}", getBook).Methods("GET")
    r.HandleFunc("/books", createBook).Methods("POST")
    r.HandleFunc("/books/{id}", updateBook).Methods("PUT")
    r.HandleFunc("/books/{id}", deleteBook).Methods("DELETE")
    
    // Start server
    fmt.Println("Server starting on :8080")
    log.Fatal(http.ListenAndServe(":8080", r))
}
```

### Working with Databases

```go
package main

import (
    "database/sql"
    "fmt"
    "log"
    "time"
    
    _ "github.com/mattn/go-sqlite3" // Import SQLite driver
)

// Define data model
type Task struct {
    ID          int
    Title       string
    Description string
    Done        bool
    CreatedAt   time.Time
    CompletedAt *time.Time
}

func main() {
    // Open database connection
    db, err := sql.Open("sqlite3", "tasks.db")
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()
    
    // Create table if it doesn't exist
    createTableSQL := `
    CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        done BOOLEAN DEFAULT FALSE,
        created_at DATETIME,
        completed_at DATETIME
    );`
    
    _, err = db.Exec(createTableSQL)
    if err != nil {
        log.Fatal(err)
    }
    
    // Insert a new task
    now := time.Now()
    result, err := db.Exec(
        "INSERT INTO tasks (title, description, created_at) VALUES (?, ?, ?)",
        "Learn Go database/sql", "Complete tutorial on using databases in Go", now,
    )
    if err != nil {
        log.Fatal(err)
    }
    
    // Get the ID of the inserted task
    id, err := result.LastInsertId()
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Inserted task with ID %d\n", id)
    
    // Query a single task
    var task Task
    err = db.QueryRow("SELECT id, title, description, done, created_at, completed_at FROM tasks WHERE id = ?", id).
        Scan(&task.ID, &task.Title, &task.Description, &task.Done, &task.CreatedAt, &task.CompletedAt)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Retrieved task: %+v\n", task)
    
    // Insert multiple tasks
    tasks := []Task{
        {Title: "Learn SQL transactions", Description: "Study ACID properties", CreatedAt: now},
        {Title: "Build a REST API", Description: "Use Go and SQLite", CreatedAt: now},
    }
    
    // Start a transaction
    tx, err := db.Begin()
    if err != nil {
        log.Fatal(err)
    }
    
    // Prepare a statement for repeated use
    stmt, err := tx.Prepare("INSERT INTO tasks (title, description, created_at) VALUES (?, ?, ?)")
    if err != nil {
        tx.Rollback()
        log.Fatal(err)
    }
    defer stmt.Close()
    
    // Execute statement for each task
    for _, task := range tasks {
        _, err = stmt.Exec(task.Title, task.Description, task.CreatedAt)
        if err != nil {
            tx.Rollback()
            log.Fatal(err)
        }
    }
    
    // Commit transaction
    err = tx.Commit()
    if err != nil {
        log.Fatal(err)
    }
    
    fmt.Println("Inserted multiple tasks")
    
    // Query all tasks
    rows, err := db.Query("SELECT id, title, description, done, created_at, completed_at FROM tasks")
    if err != nil {
        log.Fatal(err)
    }
    defer rows.Close()
    
    // Iterate through results
    fmt.Println("\nAll tasks:")
    for rows.Next() {
        var t Task
        err = rows.Scan(&t.ID, &t.Title, &t.Description, &t.Done, &t.CreatedAt, &t.CompletedAt)
        if err != nil {
            log.Fatal(err)
        }
        fmt.Printf("%d: %s - %t\n", t.ID, t.Title, t.Done)
    }
    
    if err = rows.Err(); err != nil {
        log.Fatal(err)
    }
    
    // Update a task
    completedTime := time.Now()
    _, err = db.Exec(
        "UPDATE tasks SET done = ?, completed_at = ? WHERE id = ?",
        true, completedTime, id,
    )
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Marked task %d as completed\n", id)
    
    // Delete a task
    _, err = db.Exec("DELETE FROM tasks WHERE id = ?", id)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Deleted task %d\n", id)
}
```

## Hour 23-24: Best Practices and Next Steps

### Code Organization and Style

Go has strong conventions for code organization and style. Here are some key guidelines:

1. **Package Organization**:
   - One folder = one package
   - Package names are lowercase, single-word
   - The package name should match the last element of the import path (e.g., "encoding/json" → package json)

2. **Project Structure**:
   ```
   myproject/
   ├── cmd/               # Command-line applications
   │   └── myapp/         # Your main application
   │       └── main.go    # Entry point
   ├── internal/          # Private code
   │   ├── auth/          # Authentication package
   │   └── db/            # Database package
   ├── pkg/               # Public library code
   │   └── models/        # Data models
   ├── api/               # API specs, OpenAPI/Swagger
   ├── web/               # Web assets
   ├── configs/           # Configuration files
   ├── scripts/           # Build scripts
   ├── go.mod             # Module definition
   └── go.sum             # Module checksums
   ```

3. **Code Style**:
   - Use `gofmt` or `goimports` to format your code
   - Follow the [Effective Go](https://golang.org/doc/effective_go) guidelines
   - Use linters like `golint` or `golangci-lint`

4. **Error Handling**:
   - Check errors immediately
   - Use error wrapping for context: `fmt.Errorf("reading config: %w", err)`
   - Consider custom error types for specific error cases

### Performance Optimization

Here are some tips for optimizing Go code:

1. **Profiling**:
   - Use the `pprof` tool to profile CPU and memory usage
   - Add profiling to HTTP servers:
     ```go
     import _ "net/http/pprof"
     // Then visit /debug/pprof/
     ```

2. **Memory Management**:
   - Avoid unnecessary allocations
   - Reuse objects with `sync.Pool`
   - Preallocate slices when size is known: `make([]string, 0, capacity)`

3. **Concurrency**:
   - Use the right number of goroutines (not too many)
   - Consider worker pools for limiting concurrency
   - Avoid goroutine leaks with proper cancellation

4. **I/O Optimization**:
   - Use buffered I/O with `bufio`
   - Batch database operations in transactions
   - Utilize connection pooling

### Next Steps for Continued Learning

After completing this 24-hour introduction to Go, here are recommended next steps:

1. **Dive deeper into specific areas**:
   - Advanced concurrency patterns
   - Performance optimization
   - Microservices architecture
   - gRPC and Protocol Buffers
   - Web development with larger frameworks

2. **Read these books**:
   - "The Go Programming Language" by Alan Donovan and Brian Kernighan
   - "Concurrency in Go" by Katherine Cox-Buday
   - "Go in Action" by William Kennedy

3. **Contribute to open source**:
   - Find Go projects on GitHub that interest you
   - Start with small contributions like documentation or tests
   - Learn from code reviews by experienced Go developers

4. **Join the community**:
   - Attend Go meetups (virtual or in-person)
   - Participate in forums like the Go subreddit or Gophers Slack
   - Follow Go developers on social media

## Conclusion

In just 24 hours, you've taken a whirlwind tour of Go's key features and concepts. You've learned about Go's syntax, type system, error handling, concurrency model, and much more. This is just the beginning of your Go journey.

Go's simplicity makes it easy to get started, but its depth provides endless opportunities for mastery. The language's focus on readability, performance, and practical design make it a joy to use for everything from small scripts to large-scale distributed systems.

Remember that becoming proficient in any programming language takes practice. Build small projects, contribute to open source, and most importantly, write Go code regularly to reinforce what you've learned.

Happy coding, and welcome to the Go community!