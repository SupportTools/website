---
title: "How to Extract Passwords Saved in Remmina"
date: 2025-02-16T01:58:00-06:00
draft: false
tags: ["Remmina", "Security", "Linux", "Password Recovery"]
categories:
- Security
- Linux Tools
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide on how to recover passwords saved in the Remmina Remote Desktop Client"
more_link: "yes"
url: "/extract-password-saved-in-remmina/"
---

Learn how to extract passwords that have been saved in the Remmina Remote Desktop Client.

<!--more-->

# Extracting Passwords from Remmina

## The Problem
Sometimes you might need to recover passwords saved in Remmina, the popular remote desktop client for Linux. These passwords are stored in an encrypted format in the `.remmina` directory, but they can be retrieved using a simple Python script.

## The Solution

### Prerequisites
You'll need Python installed with the following modules:
- base64
- Crypto.Cipher (from pycrypto package)

### The Decryption Script
Here's a Python script that can decrypt the saved Remmina passwords:

```python
import base64
from Crypto.Cipher import DES3

# Get the secret key from remmina.pref
secret = base64.decodestring("<STRING FROM remmina.prefs>")
# Get the encrypted password from the .remmina file
password = base64.decodestring("<STRING FROM XXXXXXX.remmina>")

# Decrypt the password using Triple DES
print DES3.new(secret[24:], DES3.MODE_CBC, secret[24:]).decrypt(password)
```

### How to Use the Script

1. **Locate the Required Files**
   - Find your Remmina configuration directory: `~/.remmina/`
   - Locate the `remmina.pref` file
   - Find the specific `.remmina` file for the connection whose password you want to recover

2. **Extract the Required Strings**
   - From `remmina.pref`: Look for a base64 encoded string
   - From your specific `.remmina` file: Find the encrypted password string

3. **Run the Script**
   - Replace the placeholder strings in the script with your actual values
   - Execute the script to get your decrypted password

## Security Considerations

1. **Local Security**
   - This method only works if you have access to the local files
   - Keep your `.remmina` directory secure
   - Consider using a password manager instead of saving passwords in Remmina

2. **System Access**
   - Anyone with access to your user account can potentially recover these passwords
   - Consider using SSH keys or other secure authentication methods for critical systems

## Alternative Approaches

1. **Password Managers**
   - Use a dedicated password manager like KeePass or Bitwarden
   - These offer better security and cross-platform accessibility

2. **SSH Keys**
   - For SSH connections, use key-based authentication
   - More secure than password-based authentication

Remember that while this method can be helpful for recovery purposes, it's important to maintain good password management practices and use secure authentication methods whenever possible.
