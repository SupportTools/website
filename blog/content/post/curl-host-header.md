---
title: "How to Set the Host Header with cURL (Easily)"
date: 2024-11-25T23:00:00-05:00
draft: true
tags: ["curl", "HTTP", "Host Header", "Bash", "TCSH"]
categories:
- HTTP
- cURL
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to set the HTTP Host header with cURL using a simple command or a convenient Bash function or TCSH alias."  
more_link: "yes"
url: "/curl-host-header/"  
---

Setting the HTTP Host header with cURL is a common task, especially when testing server configurations before making DNS changes. If you struggle to remember the right command or want a simpler way to do it, this guide provides both the command and a lazy solution: a Bash function or TCSH alias.

<!--more-->

# Introduction to Setting the Host Header with cURL

When testing server configurations before DNS changes, you often need to connect to a server (e.g., `server.example.com`) while pretending to be requesting a different hostname (e.g., `www.example.net`). This is where the HTTP Host header comes in.

The cURL command for this looks like:

```bash
curl --header 'Host: www.example.net' http://server.example.com
```

But if you’re like me, you may find this syntax hard to remember. To save time and avoid looking it up repeatedly, you can create a Bash function or TCSH alias.

## Lazy Solution 1: Bash Function

For Bash users, the solution is to define a custom function, `hcurl`, which simplifies the syntax:

### Bash Function Code
```bash
function hcurl() { 
  curl --header "Host: $1" "${@:2}" 
}
```

### How It Works
- `$1` grabs the first argument (the host for the header).
- `${@:2}` passes all other arguments to `curl`.

This allows you to run:
```bash
hcurl www.example.net http://server.example.com
```

You can also add additional cURL options:
```bash
hcurl www.example.net --silent http://server.example.com
```

### Explanation of `${@:2}`
- `$@`: All arguments passed to the function.
- `${@:2}`: A Bash slice starting from the second argument.

This ensures `hcurl` passes everything after the first argument directly to `curl`.

## Lazy Solution 2: TCSH Alias

For TCSH users, create an alias instead:

### TCSH Alias Code
```bash
alias hcurl 'curl --header "Host: \!^" \!:2-$'
```

### How It Works
- `\!^`: The first argument (equivalent to `!$:1`).
- `\!:2-$`: All arguments from the second to the last.

You can now run:
```bash
hcurl www.example.net http://server.example.com
```

### Example with Additional Options
```bash
hcurl www.example.net --silent http://server.example.com
```

## Why Use This?

- **Saves Time**: No need to remember the full cURL syntax every time.
- **Flexible**: Easily add extra options to your `hcurl` command.
- **Reusable**: Works across Bash and TCSH, adapting to your preferred shell.

## Conclusion

With these solutions, you can simplify setting the HTTP Host header with cURL. Whether you choose a Bash function or TCSH alias, you'll have a quick and reusable tool to streamline your workflow.

Remember:
```bash
hcurl www.example.net http://server.example.com
```

Never struggle with verbose commands again!