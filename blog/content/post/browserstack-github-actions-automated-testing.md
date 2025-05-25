---
title: "Setting Up Cross-Browser and Cross-Platform Testing with BrowserStack and GitHub Actions"
date: 2025-10-07T09:00:00-05:00
draft: false
tags: ["BrowserStack", "GitHub Actions", "CI/CD", "Automated Testing", "Selenium", "Appium", "Cross-Browser Testing", "Mobile Testing", "DevOps", "QA Automation"]
categories:
- Testing
- CI/CD
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing automated cross-browser and cross-platform testing using BrowserStack with GitHub Actions. Learn how to set up matrix testing for web and mobile applications with detailed workflows, configuration patterns, and best practices."
more_link: "yes"
url: "/browserstack-github-actions-automated-testing/"
---

![BrowserStack GitHub Actions Integration](/images/posts/testing/browserstack-github-actions.svg)

Implement comprehensive cross-browser and cross-platform testing automation with BrowserStack and GitHub Actions. This detailed guide walks through setting up a complete testing pipeline that runs tests across multiple browsers, operating systems, and mobile devices whenever code changes are pushed, ensuring consistent application quality across all platforms.

<!--more-->

# [Automating Cross-Platform Testing with BrowserStack and GitHub Actions](#browserstack-github-actions)

## [Introduction to BrowserStack Testing Automation](#introduction)

Effective quality assurance requires testing applications across multiple browsers, operating systems, and devices. Setting up and maintaining this infrastructure in-house is resource-intensive, requiring significant hardware, licensing, and maintenance costs. BrowserStack solves this problem by providing a cloud-based platform with access to:

- 3,000+ real devices and browsers
- Multiple OS versions for desktop and mobile
- Comprehensive test infrastructure with no maintenance overhead

When combined with GitHub Actions, you can automate your testing workflow to run comprehensive test suites whenever code changes are pushed, creating a robust continuous integration pipeline that ensures consistent application quality across all platforms.

This guide will walk you through setting up a complete BrowserStack testing automation workflow using GitHub Actions, covering:

1. Setting up the necessary GitHub repository structure
2. Creating GitHub Actions workflows for different testing scenarios
3. Configuring BrowserStack credentials and settings
4. Implementing matrix testing for comprehensive coverage
5. Analyzing test results and handling failures

## [Prerequisites for BrowserStack Testing Automation](#prerequisites)

Before getting started, ensure you have the following:

1. **GitHub Repository**: A GitHub repository where your application and tests are stored
2. **BrowserStack Account**: A valid BrowserStack account ([sign up here](https://www.browserstack.com/users/sign_up) if you don't have one)
3. **Testing Framework**: Test suite using one of the following:
   - Selenium WebDriver for web applications
   - Appium for mobile applications
   - Cypress, Playwright, TestCafe, or other supported frameworks
4. **Basic Understanding**: Familiarity with GitHub Actions concepts and YAML syntax

### [BrowserStack Account Setup](#account-setup)

If you're new to BrowserStack, follow these steps to set up your account:

1. **Sign up** for a BrowserStack account at [browserstack.com](https://www.browserstack.com/users/sign_up)
2. **Navigate** to Account > Settings
3. **Locate** your USERNAME and ACCESS KEY
4. **Note down** these credentials for later use in GitHub Actions

## [Setting Up GitHub Repository for BrowserStack Testing](#repository-setup)

### [Repository Structure](#repo-structure)

To organize your testing workflow effectively, consider the following repository structure:

```
your-repo/
├── .github/
│   └── workflows/
│       ├── browserstack-web-testing.yml     # Web testing workflow
│       └── browserstack-mobile-testing.yml  # Mobile testing workflow
├── tests/
│   ├── web/                                # Web test scripts
│   │   ├── selenium/
│   │   └── cypress/
│   └── mobile/                             # Mobile test scripts
│       ├── android/
│       └── ios/
├── browserstack-config/
│   ├── web-browsers.json                    # Web browser configurations
│   ├── mobile-devices.json                  # Mobile device configurations
│   └── browserstack.yml                     # BrowserStack configuration
└── package.json / pom.xml / build.gradle    # Project dependencies
```

### [Setting Up GitHub Secrets](#github-secrets)

To securely store your BrowserStack credentials in GitHub:

1. Navigate to your GitHub repository
2. Go to **Settings > Secrets and variables > Actions**
3. Click **New repository secret**
4. Add the following secrets:
   - Name: `BROWSERSTACK_USERNAME`
     Value: Your BrowserStack username
   - Name: `BROWSERSTACK_ACCESS_KEY`
     Value: Your BrowserStack access key

These secrets will be used in your GitHub Actions workflows without exposing the actual values in your code.

## [Creating GitHub Actions Workflows for BrowserStack](#github-actions-workflows)

Let's create comprehensive GitHub Actions workflows for both web and mobile testing.

### [Web Testing Workflow](#web-testing-workflow)

Create a file at `.github/workflows/browserstack-web-testing.yml`:

```yaml
name: BrowserStack Web Testing

# Trigger the workflow on push or pull request for specific branches
on:
  push:
    branches: [main, develop]
    paths:
      - 'src/**'
      - 'tests/web/**'
      - '.github/workflows/browserstack-web-testing.yml'
  pull_request:
    branches: [main, develop]
    paths:
      - 'src/**'
      - 'tests/web/**'
      - '.github/workflows/browserstack-web-testing.yml'
  # Allow manual workflow runs
  workflow_dispatch:
    inputs:
      browsers:
        description: 'Browsers to test (comma-separated)'
        required: false
        default: 'chrome,firefox,edge,safari'
      environment:
        description: 'Test environment'
        required: false
        default: 'staging'
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  web-testing:
    name: Web Testing - ${{ matrix.browser }}
    runs-on: ubuntu-latest
    
    strategy:
      fail-fast: false  # Continue with other browsers if one fails
      matrix:
        browser: ${{ github.event_name == 'workflow_dispatch' && split(github.event.inputs.browsers, ',') || fromJSON('["chrome", "firefox", "edge", "safari"]') }}
        include:
          - browser: chrome
            browser_version: 'latest'
            os: 'Windows'
            os_version: '11'
          - browser: firefox
            browser_version: 'latest'
            os: 'Windows'
            os_version: '11'
          - browser: edge
            browser_version: 'latest'
            os: 'Windows'
            os_version: '11'
          - browser: safari
            browser_version: 'latest'
            os: 'OS X'
            os_version: 'Monterey'
    
    env:
      BROWSERSTACK_USERNAME: ${{ secrets.BROWSERSTACK_USERNAME }}
      BROWSERSTACK_ACCESS_KEY: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
      TEST_ENV: ${{ github.event.inputs.environment || 'staging' }}
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 18
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Setup BrowserStack Environment
        uses: browserstack/github-actions/setup-env@master
        with:
          username: ${{ env.BROWSERSTACK_USERNAME }}
          access-key: ${{ env.BROWSERSTACK_ACCESS_KEY }}
      
      - name: Start BrowserStack Local Tunnel
        uses: browserstack/github-actions/setup-local@master
        with:
          local-testing: start
          local-identifier: random
      
      - name: Run WebDriver Tests on BrowserStack
        run: |
          # Export browser configuration as environment variables
          export BROWSER_NAME=${{ matrix.browser }}
          export BROWSER_VERSION=${{ matrix.browser_version }}
          export OS=${{ matrix.os }}
          export OS_VERSION="${{ matrix.os_version }}"
          
          # Run the test command
          npm run test:browserstack:web
      
      - name: Stop BrowserStack Local Tunnel
        uses: browserstack/github-actions/setup-local@master
        if: always()  # Always stop the local tunnel, even if tests fail
        with:
          local-testing: stop
      
      - name: Upload Test Reports
        uses: actions/upload-artifact@v3
        if: always()  # Always upload test reports
        with:
          name: web-test-reports-${{ matrix.browser }}
          path: test-reports/
          retention-days: 14
```

### [Mobile Testing Workflow](#mobile-testing-workflow)

Create a file at `.github/workflows/browserstack-mobile-testing.yml`:

```yaml
name: BrowserStack Mobile Testing

# Trigger the workflow on push or pull request for specific branches
on:
  push:
    branches: [main, develop]
    paths:
      - 'src/**'
      - 'tests/mobile/**'
      - '.github/workflows/browserstack-mobile-testing.yml'
  pull_request:
    branches: [main, develop]
    paths:
      - 'src/**'
      - 'tests/mobile/**'
      - '.github/workflows/browserstack-mobile-testing.yml'
  # Allow manual workflow runs
  workflow_dispatch:
    inputs:
      devices:
        description: 'Devices to test (comma-separated)'
        required: false
        default: 'android,ios'
      environment:
        description: 'Test environment'
        required: false
        default: 'staging'
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  mobile-testing:
    name: Mobile Testing - ${{ matrix.platform }} - ${{ matrix.device }}
    runs-on: ubuntu-latest
    
    strategy:
      fail-fast: false  # Continue with other devices if one fails
      matrix:
        platform: ${{ github.event_name == 'workflow_dispatch' && split(github.event.inputs.devices, ',') || fromJSON('["android", "ios"]') }}
        include:
          - platform: android
            device: 'Google Pixel 7'
            os_version: '13.0'
          - platform: android
            device: 'Samsung Galaxy S23'
            os_version: '13.0'
          - platform: ios
            device: 'iPhone 14'
            os_version: '16'
          - platform: ios
            device: 'iPhone 13'
            os_version: '15'
    
    env:
      BROWSERSTACK_USERNAME: ${{ secrets.BROWSERSTACK_USERNAME }}
      BROWSERSTACK_ACCESS_KEY: ${{ secrets.BROWSERSTACK_ACCESS_KEY }}
      TEST_ENV: ${{ github.event.inputs.environment || 'staging' }}
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3
      
      - name: Set up JDK 17
        uses: actions/setup-java@v3
        with:
          java-version: '17'
          distribution: 'temurin'
          cache: maven
      
      - name: Setup Android SDK Platform-tools
        run: |
          sudo apt-get update
          sudo apt-get install -y android-sdk-platform-tools
      
      - name: Setup BrowserStack Environment
        uses: browserstack/github-actions/setup-env@master
        with:
          username: ${{ env.BROWSERSTACK_USERNAME }}
          access-key: ${{ env.BROWSERSTACK_ACCESS_KEY }}
      
      - name: Start BrowserStack Local Tunnel
        uses: browserstack/github-actions/setup-local@master
        with:
          local-testing: start
          local-identifier: random
      
      - name: Upload App to BrowserStack
        id: app-upload
        run: |
          # For Android
          if [ "${{ matrix.platform }}" = "android" ]; then
            APP_URL=$(curl -u "$BROWSERSTACK_USERNAME:$BROWSERSTACK_ACCESS_KEY" \
              -X POST "https://api-cloud.browserstack.com/app-automate/upload" \
              -F "file=@app/build/outputs/apk/debug/app-debug.apk" \
              | jq -r '.app_url')
            echo "APP_URL=$APP_URL" >> $GITHUB_ENV
          fi
          
          # For iOS
          if [ "${{ matrix.platform }}" = "ios" ]; then
            APP_URL=$(curl -u "$BROWSERSTACK_USERNAME:$BROWSERSTACK_ACCESS_KEY" \
              -X POST "https://api-cloud.browserstack.com/app-automate/upload" \
              -F "file=@app/build/outputs/ipa/debug/app-debug.ipa" \
              | jq -r '.app_url')
            echo "APP_URL=$APP_URL" >> $GITHUB_ENV
          fi
      
      - name: Run Appium Tests on BrowserStack
        run: |
          # Export device configuration as environment variables
          export DEVICE_NAME="${{ matrix.device }}"
          export PLATFORM_NAME="${{ matrix.platform }}"
          export PLATFORM_VERSION="${{ matrix.os_version }}"
          export APP_URL="${{ env.APP_URL }}"
          
          # Run the test command
          mvn test -P browserstack-mobile
      
      - name: Stop BrowserStack Local Tunnel
        uses: browserstack/github-actions/setup-local@master
        if: always()  # Always stop the local tunnel, even if tests fail
        with:
          local-testing: stop
      
      - name: Upload Test Reports
        uses: actions/upload-artifact@v3
        if: always()  # Always upload test reports
        with:
          name: mobile-test-reports-${{ matrix.platform }}-${{ matrix.device }}
          path: target/surefire-reports/
          retention-days: 14
```

## [Configuring Test Frameworks for BrowserStack](#test-framework-config)

Now let's set up the configuration for various testing frameworks to work with BrowserStack.

### [Selenium WebDriver Configuration](#selenium-config)

Create a file `tests/web/selenium/browserstack-config.js` (for JavaScript):

```javascript
// browserstack-config.js
const webdriver = require('selenium-webdriver');
const browserstack = require('browserstack-local');

// BrowserStack Credentials
const BROWSERSTACK_USERNAME = process.env.BROWSERSTACK_USERNAME || 'YOUR_USERNAME';
const BROWSERSTACK_ACCESS_KEY = process.env.BROWSERSTACK_ACCESS_KEY || 'YOUR_ACCESS_KEY';

// Browser Configuration from Environment Variables or Default
const BROWSER_NAME = process.env.BROWSER_NAME || 'chrome';
const BROWSER_VERSION = process.env.BROWSER_VERSION || 'latest';
const OS = process.env.OS || 'Windows';
const OS_VERSION = process.env.OS_VERSION || '11';

// Project and Build Names for Reporting
const PROJECT_NAME = 'My Project';
const BUILD_NAME = `${PROJECT_NAME} - ${new Date().toISOString()}`;

// Initialize the builder
function getDriver() {
  let capabilities = {
    'bstack:options': {
      userName: BROWSERSTACK_USERNAME,
      accessKey: BROWSERSTACK_ACCESS_KEY,
      os: OS,
      osVersion: OS_VERSION,
      browserVersion: BROWSER_VERSION,
      projectName: PROJECT_NAME,
      buildName: BUILD_NAME,
      sessionName: `${BROWSER_NAME} ${BROWSER_VERSION} ${OS} ${OS_VERSION} Test`,
      local: 'true',
      debug: 'true',
      networkLogs: 'true',
      consoleLogs: 'verbose'
    },
    browserName: BROWSER_NAME
  };

  return new webdriver.Builder()
    .usingServer('https://hub-cloud.browserstack.com/wd/hub')
    .withCapabilities(capabilities)
    .build();
}

// Export the driver function
module.exports = {
  getDriver
};
```

### [Appium Configuration for Mobile Testing](#appium-config)

Create a file `tests/mobile/appium/browserstack-config.js` (for JavaScript):

```javascript
// browserstack-appium-config.js
const webdriver = require('selenium-webdriver');

// BrowserStack Credentials
const BROWSERSTACK_USERNAME = process.env.BROWSERSTACK_USERNAME || 'YOUR_USERNAME';
const BROWSERSTACK_ACCESS_KEY = process.env.BROWSERSTACK_ACCESS_KEY || 'YOUR_ACCESS_KEY';

// Device Configuration from Environment Variables
const DEVICE_NAME = process.env.DEVICE_NAME || 'Google Pixel 6';
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'android';
const PLATFORM_VERSION = process.env.PLATFORM_VERSION || '12.0';
const APP_URL = process.env.APP_URL || 'bs://your-app-hash';

// Project and Build Names for Reporting
const PROJECT_NAME = 'My Mobile Project';
const BUILD_NAME = `${PROJECT_NAME} - ${new Date().toISOString()}`;

// Initialize the builder for Appium
function getDriver() {
  let capabilities = {
    'bstack:options': {
      userName: BROWSERSTACK_USERNAME,
      accessKey: BROWSERSTACK_ACCESS_KEY,
      projectName: PROJECT_NAME,
      buildName: BUILD_NAME,
      sessionName: `${PLATFORM_NAME} ${DEVICE_NAME} ${PLATFORM_VERSION} Test`,
      deviceName: DEVICE_NAME, 
      platformName: PLATFORM_NAME,
      platformVersion: PLATFORM_VERSION,
      app: APP_URL,
      debug: true,
      networkLogs: true,
      local: 'true'
    }
  };

  return new webdriver.Builder()
    .usingServer('https://hub-cloud.browserstack.com/wd/hub')
    .withCapabilities(capabilities)
    .build();
}

// Export the driver function
module.exports = {
  getDriver
};
```

### [Maven Configuration for Java Projects](#maven-config)

For Java-based projects, create a `pom.xml` file with BrowserStack configuration:

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0" 
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    
    <groupId>com.example</groupId>
    <artifactId>browserstack-testing</artifactId>
    <version>1.0-SNAPSHOT</version>
    
    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <selenium.version>4.10.0</selenium.version>
        <appium.version>8.5.1</appium.version>
        <testng.version>7.7.1</testng.version>
    </properties>
    
    <dependencies>
        <!-- Selenium WebDriver -->
        <dependency>
            <groupId>org.seleniumhq.selenium</groupId>
            <artifactId>selenium-java</artifactId>
            <version>${selenium.version}</version>
        </dependency>
        
        <!-- Appium Java Client -->
        <dependency>
            <groupId>io.appium</groupId>
            <artifactId>java-client</artifactId>
            <version>${appium.version}</version>
        </dependency>
        
        <!-- TestNG -->
        <dependency>
            <groupId>org.testng</groupId>
            <artifactId>testng</artifactId>
            <version>${testng.version}</version>
            <scope>test</scope>
        </dependency>
        
        <!-- BrowserStack Local -->
        <dependency>
            <groupId>com.browserstack</groupId>
            <artifactId>browserstack-local-java</artifactId>
            <version>1.0.6</version>
        </dependency>
    </dependencies>
    
    <profiles>
        <!-- Web Testing Profile -->
        <profile>
            <id>browserstack-web</id>
            <build>
                <plugins>
                    <plugin>
                        <groupId>org.apache.maven.plugins</groupId>
                        <artifactId>maven-surefire-plugin</artifactId>
                        <version>3.1.2</version>
                        <configuration>
                            <suiteXmlFiles>
                                <suiteXmlFile>src/test/resources/web-test-suite.xml</suiteXmlFile>
                            </suiteXmlFiles>
                            <systemPropertyVariables>
                                <browser>${env.BROWSER_NAME}</browser>
                                <browser.version>${env.BROWSER_VERSION}</browser.version>
                                <os>${env.OS}</os>
                                <os.version>${env.OS_VERSION}</os.version>
                                <browserstack.username>${env.BROWSERSTACK_USERNAME}</browserstack.username>
                                <browserstack.key>${env.BROWSERSTACK_ACCESS_KEY}</browserstack.key>
                            </systemPropertyVariables>
                        </configuration>
                    </plugin>
                </plugins>
            </build>
        </profile>
        
        <!-- Mobile Testing Profile -->
        <profile>
            <id>browserstack-mobile</id>
            <build>
                <plugins>
                    <plugin>
                        <groupId>org.apache.maven.plugins</groupId>
                        <artifactId>maven-surefire-plugin</artifactId>
                        <version>3.1.2</version>
                        <configuration>
                            <suiteXmlFiles>
                                <suiteXmlFile>src/test/resources/mobile-test-suite.xml</suiteXmlFile>
                            </suiteXmlFiles>
                            <systemPropertyVariables>
                                <device.name>${env.DEVICE_NAME}</device.name>
                                <platform.name>${env.PLATFORM_NAME}</platform.name>
                                <platform.version>${env.PLATFORM_VERSION}</platform.version>
                                <app.url>${env.APP_URL}</app.url>
                                <browserstack.username>${env.BROWSERSTACK_USERNAME}</browserstack.username>
                                <browserstack.key>${env.BROWSERSTACK_ACCESS_KEY}</browserstack.key>
                            </systemPropertyVariables>
                        </configuration>
                    </plugin>
                </plugins>
            </build>
        </profile>
    </profiles>
</project>
```

### [Example Test Classes](#example-tests)

Create a sample Selenium test class (Java):

```java
// src/test/java/com/example/WebTest.java
package com.example;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.remote.DesiredCapabilities;
import org.openqa.selenium.remote.RemoteWebDriver;
import org.testng.Assert;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

import java.net.URL;
import java.util.HashMap;
import java.util.Map;

public class WebTest {
    
    private WebDriver driver;

    @BeforeMethod
    public void setUp() throws Exception {
        String username = System.getProperty("browserstack.username");
        String accessKey = System.getProperty("browserstack.key");
        String browserstackURL = "https://" + username + ":" + accessKey + "@hub-cloud.browserstack.com/wd/hub";
        
        DesiredCapabilities capabilities = new DesiredCapabilities();
        capabilities.setCapability("browserName", System.getProperty("browser"));
        capabilities.setCapability("browserVersion", System.getProperty("browser.version"));
        
        Map<String, Object> bstackOptions = new HashMap<>();
        bstackOptions.put("os", System.getProperty("os"));
        bstackOptions.put("osVersion", System.getProperty("os.version"));
        bstackOptions.put("projectName", "Example Project");
        bstackOptions.put("buildName", "Build-1");
        bstackOptions.put("sessionName", "Web Test");
        bstackOptions.put("local", "true");
        
        capabilities.setCapability("bstack:options", bstackOptions);
        
        driver = new RemoteWebDriver(new URL(browserstackURL), capabilities);
    }

    @Test
    public void testWebApplication() {
        driver.get("https://www.example.com");
        
        // Verify page title
        String title = driver.getTitle();
        Assert.assertEquals("Example Domain", title);
        
        // Verify page content
        WebElement heading = driver.findElement(By.tagName("h1"));
        Assert.assertEquals("Example Domain", heading.getText());
    }

    @AfterMethod
    public void tearDown() {
        if (driver != null) {
            driver.quit();
        }
    }
}
```

Create a sample Appium test class (Java):

```java
// src/test/java/com/example/MobileTest.java
package com.example;

import io.appium.java_client.AppiumDriver;
import org.openqa.selenium.remote.DesiredCapabilities;
import org.testng.Assert;
import org.testng.annotations.AfterMethod;
import org.testng.annotations.BeforeMethod;
import org.testng.annotations.Test;

import java.net.URL;
import java.util.HashMap;
import java.util.Map;

public class MobileTest {
    
    private AppiumDriver driver;

    @BeforeMethod
    public void setUp() throws Exception {
        String username = System.getProperty("browserstack.username");
        String accessKey = System.getProperty("browserstack.key");
        String browserstackURL = "https://" + username + ":" + accessKey + "@hub-cloud.browserstack.com/wd/hub";
        
        DesiredCapabilities capabilities = new DesiredCapabilities();
        
        Map<String, Object> bstackOptions = new HashMap<>();
        bstackOptions.put("deviceName", System.getProperty("device.name"));
        bstackOptions.put("platformName", System.getProperty("platform.name"));
        bstackOptions.put("platformVersion", System.getProperty("platform.version"));
        bstackOptions.put("app", System.getProperty("app.url"));
        bstackOptions.put("projectName", "Example Mobile Project");
        bstackOptions.put("buildName", "Mobile-Build-1");
        bstackOptions.put("sessionName", "Mobile Test");
        bstackOptions.put("local", "true");
        
        capabilities.setCapability("bstack:options", bstackOptions);
        
        driver = new AppiumDriver(new URL(browserstackURL), capabilities);
    }

    @Test
    public void testMobileApplication() {
        // Example mobile app test
        // This is a simplified example - replace with actual app testing logic
        Assert.assertTrue(driver.getPageSource().contains("Welcome"));
    }

    @AfterMethod
    public void tearDown() {
        if (driver != null) {
            driver.quit();
        }
    }
}
```

## [Advanced Configuration and Features](#advanced-configuration)

### [Parallel Testing with BrowserStack](#parallel-testing)

BrowserStack allows running tests in parallel, which significantly reduces testing time. Configure your test framework to run tests in parallel:

For TestNG, create a file `src/test/resources/web-test-suite.xml`:

```xml
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<suite name="BrowserStack Web Suite" parallel="tests" thread-count="5">
    <test name="Web Test">
        <classes>
            <class name="com.example.WebTest"/>
        </classes>
    </test>
</suite>
```

### [Visual Testing with Percy](#visual-testing)

Integrate Percy for visual testing by adding to your GitHub Actions workflow:

```yaml
- name: Setup Percy
  run: |
    npm install --save-dev @percy/cli
    npx percy exec -- npm run test:visual
  env:
    PERCY_TOKEN: ${{ secrets.PERCY_TOKEN }}
```

### [Configuring Test Reporting](#test-reporting)

Enhance your test reporting by integrating with BrowserStack's reports:

```yaml
- name: Generate BrowserStack Report URLs
  if: always()
  run: |
    # Get BrowserStack build ID
    BUILD_ID=$(curl -s -u "$BROWSERSTACK_USERNAME:$BROWSERSTACK_ACCESS_KEY" \
      "https://api.browserstack.com/automate/builds.json" | \
      jq -r '.[0].automation_build.hashed_id')
    
    echo "BrowserStack Build Report: https://automate.browserstack.com/builds/$BUILD_ID"
    
    # Create a markdown summary
    echo "## BrowserStack Test Results" >> $GITHUB_STEP_SUMMARY
    echo "🔗 [View detailed test report](https://automate.browserstack.com/builds/$BUILD_ID)" >> $GITHUB_STEP_SUMMARY
```

### [Environment-Specific Testing](#environment-testing)

Set up environment-specific configurations in your tests:

```javascript
// Get environment from environment variable
const TEST_ENV = process.env.TEST_ENV || 'staging';

// Environment URLs
const ENVIRONMENT_URLS = {
  development: 'https://dev.example.com',
  staging: 'https://staging.example.com',
  production: 'https://www.example.com'
};

// Use the correct URL based on environment
const BASE_URL = ENVIRONMENT_URLS[TEST_ENV];

// In your test:
driver.get(BASE_URL);
```

## [Advanced Matrix Testing Strategies](#matrix-strategies)

### [Browser Version Matrix](#browser-version-matrix)

Test across multiple browser versions by expanding your matrix configuration:

```yaml
strategy:
  matrix:
    browser: [chrome, firefox, edge, safari]
    browser_version: [latest, latest-1]
    include:
      # Latest version of each browser
      - browser: chrome
        browser_version: latest
        os: Windows
        os_version: 11
      - browser: firefox
        browser_version: latest
        os: Windows
        os_version: 11
      - browser: edge
        browser_version: latest
        os: Windows
        os_version: 11
      - browser: safari
        browser_version: latest
        os: OS X
        os_version: Monterey
      
      # Previous versions for compatibility
      - browser: chrome
        browser_version: latest-1
        os: Windows
        os_version: 10
      - browser: firefox
        browser_version: latest-1
        os: Windows
        os_version: 10
      - browser: edge
        browser_version: latest-1
        os: Windows
        os_version: 10
      - browser: safari
        browser_version: '15'
        os: OS X
        os_version: Big Sur
    exclude:
      # Exclude specific combinations if needed
      - browser: safari
        browser_version: latest-1
```

### [Mobile Device Matrix](#mobile-device-matrix)

Expand your mobile testing matrix for comprehensive coverage:

```yaml
strategy:
  matrix:
    device_config:
      # Android devices
      - device: "Google Pixel 7"
        os_version: "13.0"
        platform: "android"
      - device: "Samsung Galaxy S23"
        os_version: "13.0"
        platform: "android"
      - device: "OnePlus 9"
        os_version: "11.0"
        platform: "android"
      - device: "Xiaomi Redmi Note 11"
        os_version: "11.0"
        platform: "android"
        
      # iOS devices
      - device: "iPhone 14 Pro Max"
        os_version: "16"
        platform: "ios"
      - device: "iPhone 13"
        os_version: "15"
        platform: "ios"
      - device: "iPhone 12"
        os_version: "14"
        platform: "ios"
      - device: "iPad Pro 12.9 2022"
        os_version: "16"
        platform: "ios"
```

## [Best Practices for BrowserStack Testing](#best-practices)

### [Optimizing Test Execution Time](#optimizing-time)

1. **Parallelize Tests**: Run tests in parallel to reduce overall execution time
2. **Smart Selection**: Test newest browsers on newest OS, and older browsers on older OS
3. **Prioritize Devices**: Focus on devices with highest user base
4. **Selective Testing**: Run full suite on PR to main, but limit to critical paths on other branches

### [Handling Flaky Tests](#flaky-tests)

1. **Implement Retries**: Configure your test framework to retry failed tests
   
   ```java
   // TestNG example
   @Test(retryAnalyzer = RetryAnalyzer.class)
   public void testFeature() {
       // Test implementation
   }
   ```

2. **Add Proper Waits**: Use explicit waits instead of fixed sleeps
   
   ```java
   WebDriverWait wait = new WebDriverWait(driver, Duration.ofSeconds(10));
   wait.until(ExpectedConditions.visibilityOfElementLocated(By.id("element")));
   ```

3. **Implement Screenshot on Failure**: Capture screenshots for debugging
   
   ```java
   @AfterMethod
   public void tearDown(ITestResult result) {
       if (ITestResult.FAILURE == result.getStatus()) {
           TakesScreenshot ts = (TakesScreenshot) driver;
           File source = ts.getScreenshotAs(OutputType.FILE);
           // Save the screenshot
       }
   }
   ```

### [Security Considerations](#security)

1. **Secure Credentials**: Always use GitHub Secrets for BrowserStack credentials
2. **Limit Access**: Restrict access to test results and reports
3. **Sanitize Test Data**: Never use real user data in tests
4. **Rotate Access Keys**: Periodically rotate your BrowserStack access keys

### [Maintenance Strategies](#maintenance)

1. **Centralize Configuration**: Keep browser/device configurations in a separate file
2. **Use Page Object Model**: Implement the Page Object Model pattern for easier maintenance
3. **Automated Dependency Updates**: Use Dependabot to keep dependencies updated
4. **Documentation**: Maintain clear documentation on the testing process

## [Troubleshooting Common Issues](#troubleshooting)

### [Local Testing Connection Problems](#local-connection)

If you encounter issues with BrowserStack Local:

1. **Check for Connection Errors**:
   ```
   Error: Could not establish connection. Possible causes are:
   ```

   **Solution**: Verify network settings, firewall rules, and proxy configurations

2. **Manual Local Testing Verification**:
   ```bash
   # Download BrowserStackLocal binary
   curl -o BrowserStackLocal https://www.browserstack.com/browserstack-local/BrowserStackLocal-linux-x64.zip
   unzip BrowserStackLocal-linux-x64.zip
   
   # Run with debug flag
   ./BrowserStackLocal --key YOUR_ACCESS_KEY --force-local --verbose
   ```

### [Test Timeout Issues](#test-timeout)

If tests are timing out:

1. **Increase Session Timeout**:
   ```javascript
   capabilities['bstack:options'].sessionTimeout = '30m';
   ```

2. **Check Test Execution Time**:
   - Review BrowserStack logs for long-running operations
   - Simplify or split tests that take too long

### [Device/Browser Availability](#device-availability)

If specific devices or browsers are unavailable:

1. **Check BrowserStack Status**:
   - Visit [BrowserStack Status](https://status.browserstack.com/)
   - Use alternative device/browser combinations temporarily

2. **Implement Smart Retries**:
   ```yaml
   steps:
     - name: Run Tests with Retry
       uses: nick-invision/retry@v2
       with:
         timeout_minutes: 15
         max_attempts: 3
         command: npm run test:browserstack
   ```

## [Integration with Other CI/CD Tools](#other-integrations)

While this guide focuses on GitHub Actions, you can adapt the configuration for other CI/CD systems:

### [GitLab CI/CD](#gitlab)

Create a `.gitlab-ci.yml` file:

```yaml
stages:
  - test

variables:
  BROWSERSTACK_USERNAME: ${BROWSERSTACK_USERNAME}
  BROWSERSTACK_ACCESS_KEY: ${BROWSERSTACK_ACCESS_KEY}

web-testing:
  stage: test
  image: node:18
  script:
    - npm ci
    - npm run test:browserstack:web
  artifacts:
    paths:
      - test-reports/
    expire_in: 1 week
```

### [Jenkins Pipeline](#jenkins)

Create a `Jenkinsfile`:

```groovy
pipeline {
    agent any
    
    environment {
        BROWSERSTACK_USERNAME = credentials('browserstack-username')
        BROWSERSTACK_ACCESS_KEY = credentials('browserstack-access-key')
    }
    
    stages {
        stage('Setup') {
            steps {
                sh 'npm ci'
            }
        }
        
        stage('Test') {
            steps {
                sh 'npm run test:browserstack'
            }
        }
    }
    
    post {
        always {
            archiveArtifacts artifacts: 'test-reports/**/*', fingerprint: true
        }
    }
}
```

## [Conclusion](#conclusion)

You now have a comprehensive guide to implementing cross-browser and cross-platform testing with BrowserStack and GitHub Actions. This setup enables you to:

1. **Test Across Multiple Environments**: Web browsers, operating systems, and mobile devices
2. **Automate Your Testing Pipeline**: Trigger tests on code changes
3. **Implement Matrix Testing**: Run tests in parallel for faster feedback
4. **Integrate with Your CI/CD Workflow**: Seamlessly fit testing into your development process

By thoroughly testing your applications on real browsers and devices, you can catch platform-specific issues early and ensure a consistent user experience for all your users.

## [Further Resources](#resources)

- [BrowserStack Documentation](https://www.browserstack.com/docs/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Selenium Documentation](https://www.selenium.dev/documentation/)
- [Appium Documentation](http://appium.io/docs/en/about-appium/intro/)
- [TestNG Documentation](https://testng.org/doc/documentation-main.html)