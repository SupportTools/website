---
title: "Testing in Go: A Crash Course to Get You Going"  
date: 2024-09-18T19:26:00-05:00  
draft: false  
tags: ["Go", "Testing", "Golang", "Unit Tests", "Automation"]  
categories:  
- Go  
- Testing  
- Programming  
author: "Matthew Mattox - mmattox@support.tools"  
description: "Learn the basics of testing in Go with this crash course, covering essential concepts to help you get started quickly."  
more_link: "yes"  
url: "/testing-in-go-crash-course/"  
---

Testing is a critical part of developing reliable applications, and Go makes it simple with its built-in testing framework. In this crash course, we’ll walk you through the basics of testing in Go, covering how to write unit tests, use Go’s testing tools, and structure your tests for success.

<!--more-->

### Why Test in Go?

Go’s simplicity extends to its testing framework, which is lightweight, built-in, and easy to use. Testing in Go helps ensure that your code functions as expected, catches bugs early, and provides a foundation for more robust applications.

### Step 1: Writing Your First Unit Test

Go uses a built-in package called `testing` for writing and running tests. Let’s start by writing a simple test for a function that adds two numbers.

#### Example Function

Here’s an example of a simple `Add` function in `math.go`:

```go
package math

func Add(a, b int) int {
    return a + b
}
```

Now, let’s write a test for this function.

#### Test Function

In Go, test files should have the `_test.go` suffix, and test functions should start with `Test`. Let’s create a test file `math_test.go`:

```go
package math

import "testing"

func TestAdd(t *testing.T) {
    result := Add(2, 3)
    expected := 5

    if result != expected {
        t.Errorf("Add(2, 3) = %d; want %d", result, expected)
    }
}
```

This test compares the output of `Add(2, 3)` with the expected result (`5`). If the result doesn’t match the expectation, the test will fail.

### Step 2: Running Tests

Running tests in Go is simple. Use the `go test` command:

```bash
go test
```

This will automatically find and run all test functions in files ending with `_test.go`. You’ll get feedback on which tests passed and which failed.

For more detailed output, you can run:

```bash
go test -v
```

This provides verbose output, showing all test results.

### Step 3: Table-Driven Tests

Go supports table-driven tests, which allow you to test multiple inputs and expected outputs in a clean and maintainable way. This is especially useful when you need to test a function with many different inputs.

Here’s how to write a table-driven test for the `Add` function:

```go
func TestAddTableDriven(t *testing.T) {
    tests := []struct {
        a, b, expected int
    }{
        {1, 1, 2},
        {2, 2, 4},
        {3, 3, 6},
        {10, 5, 15},
    }

    for _, tt := range tests {
        result := Add(tt.a, tt.b)
        if result != tt.expected {
            t.Errorf("Add(%d, %d) = %d; want %d", tt.a, tt.b, result, tt.expected)
        }
    }
}
```

In this example, we define a table of test cases (`tests`), then loop through each test case to check if the function behaves as expected.

### Step 4: Testing for Errors

Sometimes, you want to test that a function returns an error when certain conditions are met. Here’s how you can test error handling in Go.

#### Example Function with Error Handling

Let’s create a function that divides two numbers but returns an error if the denominator is zero:

```go
package math

import "errors"

func Divide(a, b int) (int, error) {
    if b == 0 {
        return 0, errors.New("division by zero")
    }
    return a / b, nil
}
```

#### Test for Error Handling

Now, let’s write a test to check that the `Divide` function behaves correctly:

```go
func TestDivide(t *testing.T) {
    _, err := Divide(10, 0)
    if err == nil {
        t.Error("expected error, got nil")
    }

    result, err := Divide(10, 2)
    if err != nil {
        t.Errorf("unexpected error: %v", err)
    }
    expected := 5
    if result != expected {
        t.Errorf("Divide(10, 2) = %d; want %d", result, expected)
    }
}
```

This test verifies that the function returns an error when dividing by zero and works correctly for valid inputs.

### Step 5: Benchmarking in Go

Go’s testing framework also supports benchmarking, which allows you to measure the performance of your functions. Benchmark functions start with `Benchmark` and take a `*testing.B` parameter.

Here’s an example benchmark for the `Add` function:

```go
func BenchmarkAdd(b *testing.B) {
    for i := 0; i < b.N; i++ {
        Add(2, 3)
    }
}
```

Run the benchmark with:

```bash
go test -bench=.
```

Go will execute the benchmark and show how long it takes to run the function.

### Step 6: Structuring Your Test Files

Organizing your tests is important for maintainability. Here’s a common structure for Go projects with testing:

```bash
/myproject
  /math
    math.go
    math_test.go
  /strings
    strings.go
    strings_test.go
```

This structure keeps test files in the same package as the code they are testing, making it easier to manage and run tests.

### Final Thoughts

Testing in Go is simple yet powerful, allowing you to write reliable code quickly. With features like built-in testing, table-driven tests, and benchmarking, Go provides all the tools you need to ensure your application runs smoothly and efficiently. By following this crash course, you’ll be ready to write and run your first tests in Go.
