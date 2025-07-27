---
title: "Go For Fun: Sequence Breaking using For"
date: 2023-10-13T15:50:00-05:00
draft: false
tags: ["Go", "Programming", "Control Flow"]
categories:
- GoLang
- Programming
author: "Matthew Mattox - mmattox@support.tools"
description: "Exploring a fun alternative for sequence breaking using 'for' in Go."
more_link: "yes"
---

Using early return is a well-known Go programming language trait.

A function must return early, as soon as possible, whenever it encounters errors. That way, there is only one possible happy path: reaching the end of the function. Thus, if you have multiple ways of achieving that happy path, it is recommended to break it apart into two different functions.

Consider this example snippet:

```go
func DoSequence(input Input) (result string, err error) {
    // Do A
    if input.FieldA == "nothing" {
        return "", errors.New("Error A")
    }
    // Do B
    if input.FieldB == "nothing" {
        return "", errors.New("Error B")
    }
    // Do C
    if input.FieldC == "nothing" {
        return "", errors.New("Error C")
    }
    // All done!
    return "success", nil
}
```

In the above snippet, whenever the execution reaches a failure condition (the if statement for each Do A, Do B, etc), it returns early by sending the error message. So, the result is only accessible if we pass all these early returns. As you can see, this gets very verbose quickly. But people like them because the execution order is flat and linear.

However, things get messy when the sequence is not linear or contains several branches before converging into the happy path. It is encouraged to break apart the flow into separate functions whenever it happens. That way, you set cognitive boundaries by requiring the reader to understand one function as just one flat flow.

In some cases, creating a function complicates things because you need to pass the context and variables of the parent function into this child function. If the function is only used once, it adds little benefit since you increase the call stack, but it is unnecessary because only one parent executes that function. To add to the confusion, reading a package with many non-flat private functions needs to be clarified at which level those private functions are called. This also makes your code prone to refactoring if the parent context changes, and you need to pass more variables to these functions. It is easier to review after actually jumping into the code.

In the above example, consider a case where you need to do 3 things in Do A:

- For some errors, you return early (like usual).
- You return early with a successful result for a successful Do A with some condition.
- You must proceed into Do C for a failed Do A with a fallthrough/fallback condition.

Semantically, if DoA is a function, you would create the function in such a way that point 3 is the happy path of the function. That way, it is seen last in the code body. But, it is unclear because point 3 means that you failed to execute DoA, so you need to fall back to execute another function: DoC. A better way to read DoA is to put point 2 as the last return, just like how the Go function uses early return. We now realize that a semantic structure in DoA doesn’t necessarily mean the same semantic design makes sense for the parent DoSequence. Now, add some nested ifs and functions; you suddenly have spaghetti code that is easy to write but hard to read, especially if this is a business logic whole of criteria/branch flows.

In languages like Python, it is easily solved because they have a try-except-finally control flow. You could wrap all of them in one try block, then let the Do A block raise an appropriate error if it needs to return early by throwing an error. Return as usual if it needs to return early with a successful result. Then, if it needs to fall back to Do C, just put Do C in a final block, and then let the Do A block raise a handled error in the except block.

This is impossible in Go, so here’s my preferred fun alternative.

You can break out of the block using a for block while still being in the same function. This is a much more concise block rather than anonymous functions (which I prefer if the whole thing is functional), switch block (too verbose if the first condition has only one case), defer block (you should not use this for control flow), or goto statement (can be a nightmare to manage).

Here’s what it looks like for these kinds of cases:

```go
func DoSequence(input Input) (result string, err error) {
    // Do A
    for range [1]bool{} {
        if input.FieldA == "nothing" {
            return "", errors.New("Error A")
        }
        if input.FieldA == "something" {
            //We want to fallback by continuing to Do B and Do C
            break
        }

        // do some A stuff Here
        resultA, err := mypackage.CallA(input)

        // successful result that needs early return
        if resultA == "success" {
            return resultA, nil
        }

        // other resultA that needs fallback to Do B and Do C
        // will naturally exit this block
    }
    // Do B
    if input.FieldB == "nothing" {
        return "", errors.New("Error B")
    }
    // Do C
    if input.FieldC == "nothing" {
        return "", errors.New("Error C")
    }
    // All done!
    return "success", nil
}
```

The for block executes only once using the range `[1]bool{}` statement to iterate a slice with one element. You could also use a more straightforward `for i := 0; i == 0; i++`, but for me, it is another case of "it is easier to write it than read it" thing. The range statement is easier to read and understand at a glance.

As a remark note, if we have multiple pre-conditions to check for the execution to enter the // Do A block, then use the switch. That’s what it is used for.

```go
func DoSequence(input Input) (result string, err error) {
    // Do A
    switch {
    case <condition-1>, <condition-2>, <condition-3>:
        if input.FieldA == "nothing" {
            return "", errors.New("Error A")
        }
        if input.FieldA == "something" {
            //We want to fallback by continuing to Do B and Do C
            break
        }

        // do some A stuff Here
        resultA, err := mypackage.CallA(input)

        // successful result that needs early return
        if resultA == "success" {
            return resultA, nil
        }

        // other resultA that needs fallback to Do B and Do C
        // will naturally exit this block
    }
    // Do B
    if input.FieldB == "nothing" {
        return "", errors.New("Error B")
    }
    // Do C
    if input.FieldC == "nothing" {
        return "", errors.New("Error C")
    }
    // All done!
    return "success", nil
}
```

Frankly, I wish people switched more. But most programmers have been hardwired to think that switch is used as a kind of map or pattern match rather than statement blocks. So perhaps “for once” semantics is more acceptable for them.

**What do you think? For once, or switch true?**

In Go, you often choose between using a `for` block with a single iteration to control your flow or a `switch true` statement to create a similar effect. The decision comes down to your coding style and readability preferences.

Using a `for` block as a control flow mechanism is a concise and effective way to handle situations where you want to prematurely exit a block of code while staying within the same function. It can be a cleaner alternative to anonymous functions, switch statements with only one case, defer blocks (which should not be used for control flow), or goto statements, which can become challenging to manage.

On the other hand, some developers might prefer using `switch true` to achieve a similar effect. It's a valid approach, but it may look unconventional to those more accustomed to traditional switch statements for pattern matching or mapping values.

Ultimately, the choice between "for once" and `switch true` depends on your team's coding conventions and your coding style. Both approaches achieve the same goal of early return or branching within a function, so you can choose the one that makes your code more readable and maintainable.

Please let me know if you'd like to continue reading or have any specific questions.
