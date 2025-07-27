---
title: "How to Sign Commits for GitHub"
date: 2023-08-12T02:00:00-05:00
draft: false
tags: ["GitHub", "Git"]
categories:
- GitHub
- Git
author: "Matthew Mattox - mmattox@support.tools"
description: "Dive into the importance of verified commits on GitHub and learn how to sign them."
more_link: "yes"
---

Dive into the importance of verified commits on GitHub and learn how to sign them. For anyone using GitHub or similar platforms, ensuring the authenticity of your commits is paramount. 

<!--more-->
# [Why Sign Your Commits?](#why-sign-your-commits)

GitHub relies on the **email** configured in your local git to link the commit author to an account. This presents an opportunity for commit spoofing. Signing commits authenticates they originate from the correct account. While commits made via GitHub's web interface are automatic **Verified**, local commits need manual signing.

# [Signing Methods](#signing-methods)

Various methods for signing commits exist:
1. GPG key
2. SSH key
3. S/MIME x.509 certificate

This guide covers the first two. Both HTTPS and SSH git protocols support these methods. GPG keys come with expiration; SSH keys don't.

For in-depth considerations, read [Ken Muse's article](https://www.kenmuse.com/blog/comparing-github-commit-signing-options/).

# [Signing with a GPG Key](#signing-with-a-gpg-key)

A GPG key is one of the most common ways to sign commits. Here's a step-by-step guide:

1. **Generate GPG Key**: Execute the command in your terminal or Git bash:
   ```
   gpg --full-generate-key
   ```
   Follow the prompts, accepting default options where necessary. Make sure the email you provide matches your primary GitHub email.

2. **List Your GPG Keys**:
   ```
   gpg --list-secret-keys --keyid-format=long
   ```
   This will provide a list of your GPG keys. You'll need the key ID for the next steps.

3. **Configure Git with Your GPG Key**:
   Replace `YOUR_GPG_KEY_ID` with your key ID from the previous step.
   ```
   git config --global user.signingkey YOUR_GPG_KEY_ID
   ```

4. **Export GPG Key**:
   Retrieve the public portion of your GPG key. Again, replace `YOUR_GPG_KEY_ID` with your actual key ID.
   ```
   gpg --armor --export YOUR_GPG_KEY_ID
   ```
   Copy the output. This is what you'll add to GitHub.

5. **Add GPG Key to GitHub**:
   Navigate to [GitHub settings](https://github.com/settings/keys) and add your GPG key under the GPG key section.

6. **Configuring Git to Sign Commits**:
   This ensures every commit you make is signed.
   ```
   git config --global commit.gpgsign true
   ```
   Alternatively, to sign individual commits, add the `-S` flag when committing, like:
   ```
   git commit -S -m "Your commit message here"
   ```

7. **Handle GPG Errors (Optional)**:
   For MacOS users who encounter an error (`gpg: signing failed: Inappropriate ioctl for device`), run:
   ```
   export GPG_TTY=\$TTY
   ```
   Add this line to the top of your shell profile for persistence.

8. **Push Commits**:
   After you've committed your changes, push them to GitHub. Your commits should now display as **Verified**.

Remember, using GPG keys not only adds a layer of authenticity to your commits but also boosts the overall security of your codebase.


# [Signing with an SSH Key](#signing-with-an-ssh-key)

Using SSH keys is an alternative way to sign commits, which is incredibly convenient if you're already using SSH keys for repository access. Follow these steps:

1. **Generate an SSH Key (if you don't have one)**:
   Replace `your_email@example.com` with the email you use for GitHub.
   ```code
   ssh-keygen -t ed25519 -C "your_email@example.com"
   ```
   During generation, you'll have the option to add a passphrase for added security.

2. **Link SSH Key to Git**:
   ```code
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   ```

3. **Switch Git to Use SSH for Signing**:
   ```code
   git config --global gpg.format ssh
   ```

4. **Retrieve the Public SSH Key**:
   ```code
   cat ~/.ssh/id_ed25519.pub
   ```
   Copy the displayed public key. 

5. **Add SSH Key to GitHub**:
   Visit [GitHub SSH settings](https://github.com/settings/keys) and paste your public key. Make sure to add it as an SSH **signing** key.

6. **Configure Git for Auto-Signing Commits**:
   If you'd like every commit to be signed automatically:
   ```code
   git config --global commit.gpgsign true
   ```
   Alternatively, to sign commits individually, use the following:
   ```code
   git commit -S -m "Your commit message here"
   ```

7. **Commit and Push**:
   After committing your changes, push them to GitHub. Your commits will appear as **Verified**, indicating they were signed with your SSH key.

Signing with an SSH key provides a seamless experience, especially if SSH is already a part of your workflow. It's another effective way to authenticate and secure your commits.


# [Final Thoughts](#final-thoughts)

Commit signing, whether through GPG or SSH keys, plays a vital role in maintaining the integrity and authenticity of your codebase. It adds a layer of trust and verification for collaborators and consumers of your code, ensuring that the code they see is genuinely from the indicated author and hasn't been tampered with.

If you haven't yet adopted commit signing, the steps provided in the previous sections help simplify the process. While it might seem like an additional step in your workflow initially, the peace of mind it brings in ensuring code authenticity is invaluable.

Moreover, as security becomes an ever-growing concern in the software world, taking these proactive steps protects your work and showcases a commitment to best practices. This can be especially significant in a collaborative environment, such as open-source projects.

In conclusion, take a moment to set up a commit signing. The initial setup might take a few minutes, but the long-term benefits of code security and trustworthiness are worth the effort.