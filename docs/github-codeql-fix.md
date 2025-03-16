# Fixing CodeQL Analysis Configuration Error

## Problem

GitHub is reporting the following error when attempting to process CodeQL analysis:

```
Code Scanning could not process the submitted SARIF file: CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled
```

This error occurs because there is a conflict between:

1. **GitHub's Default CodeQL Setup** (enabled in repository settings)
2. **Custom CodeQL Workflow** (defined in `.github/workflows/codeql.yml`)

GitHub does not support running both configurations simultaneously for the same language.

## Solution

Disable the default CodeQL setup in GitHub repository settings to allow your custom workflow to run properly:

1. Navigate to your GitHub repository
2. Go to **Settings** > **Code security and analysis**
3. Find the **Code scanning** section
4. Click the **Configure** or **Disable** button next to "Default setup"
5. Select **Disable default setup**
6. Save your changes

Your custom CodeQL workflow (`.github/workflows/codeql.yml`) will now run without conflicts with the default setup.

## Why This Approach?

The custom workflow is preferred because:

1. It provides more control over the scanning configuration
2. It can be version controlled along with your codebase
3. It integrates better with your existing CI/CD pipeline
4. It can be customized for your specific Go codebase needs

## Custom Workflow Details

Your current custom CodeQL workflow:
- Runs on pushes to main, pull requests to main, and weekly (Sunday at midnight)
- Analyzes Go language code
- Uses the latest CodeQL action (v3)
- Has appropriate permissions for security event writing
