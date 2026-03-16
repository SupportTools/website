---
title: "Frontend Security: CSP, CORS, and XSS Prevention in Modern Web Apps"
date: 2026-07-10T00:00:00-05:00
draft: false
tags: ["Security", "Frontend", "CSP", "CORS", "XSS", "Web Security", "JavaScript", "OWASP"]
categories:
- Security
- Frontend Development
- Best Practices
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing robust security measures in modern web applications, covering Content Security Policy, CORS configuration, XSS prevention, authentication patterns, and vulnerability testing"
more_link: "yes"
url: "/frontend-security-csp-cors-xss-prevention-modern-web-apps/"
keywords:
- Frontend security
- Content Security Policy
- CORS configuration
- XSS prevention
- Web application security
- Security headers
- Authentication patterns
- OWASP Top 10
---

In today's interconnected digital landscape, frontend security has become more critical than ever. With sophisticated attacks targeting client-side applications, implementing robust security measures is not optional—it's essential. This comprehensive guide explores advanced security techniques for modern web applications, focusing on CSP, CORS, XSS prevention, and enterprise-grade security patterns.

<!--more-->

# Frontend Security: CSP, CORS, and XSS Prevention in Modern Web Apps

## Understanding the Modern Web Security Landscape

The evolution of web applications from simple static pages to complex single-page applications (SPAs) has dramatically expanded the attack surface. Modern frontend applications face numerous security challenges:

1. **Cross-Site Scripting (XSS)**: Still the most common vulnerability in web applications
2. **Cross-Site Request Forgery (CSRF)**: Exploiting authenticated sessions
3. **Code Injection**: Malicious code execution through various vectors
4. **Data Exposure**: Sensitive information leakage through client-side code
5. **Third-Party Dependencies**: Vulnerabilities in npm packages and CDN resources
6. **Supply Chain Attacks**: Compromised dependencies and build tools

### The Security Triad for Frontend Applications

```
┌─────────────────────────────────────────────────────────────┐
│                    Security Layers                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  │
│  │   Prevention  │  │   Detection   │  │   Response    │  │
│  │               │  │               │  │               │  │
│  │ • CSP         │  │ • Monitoring  │  │ • Incident    │  │
│  │ • Input       │  │ • Logging     │  │   Response    │  │
│  │   Validation  │  │ • Alerts      │  │ • Patching    │  │
│  │ • CORS        │  │ • Auditing    │  │ • Recovery    │  │
│  └───────────────┘  └───────────────┘  └───────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Content Security Policy (CSP) Implementation

Content Security Policy is a powerful security standard that helps prevent XSS attacks by specifying which content sources are allowed to be loaded and executed.

### Advanced CSP Configuration

```typescript
// src/security/csp.ts
interface CSPDirectives {
  [directive: string]: string[];
}

class ContentSecurityPolicyBuilder {
  private directives: CSPDirectives = {};
  private reportUri?: string;
  private reportOnly: boolean = false;

  constructor() {
    // Set default secure directives
    this.setDefaultDirectives();
  }

  private setDefaultDirectives(): void {
    this.directives = {
      'default-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
    };
  }

  // Directive setters with validation
  setScriptSrc(...sources: string[]): this {
    this.directives['script-src'] = this.validateSources(sources);
    return this;
  }

  setStyleSrc(...sources: string[]): this {
    this.directives['style-src'] = this.validateSources(sources);
    return this;
  }

  setImgSrc(...sources: string[]): this {
    this.directives['img-src'] = this.validateSources(sources);
    return this;
  }

  setConnectSrc(...sources: string[]): this {
    this.directives['connect-src'] = this.validateSources(sources);
    return this;
  }

  setFontSrc(...sources: string[]): this {
    this.directives['font-src'] = this.validateSources(sources);
    return this;
  }

  setMediaSrc(...sources: string[]): this {
    this.directives['media-src'] = this.validateSources(sources);
    return this;
  }

  setFrameSrc(...sources: string[]): this {
    this.directives['frame-src'] = this.validateSources(sources);
    return this;
  }

  setWorkerSrc(...sources: string[]): this {
    this.directives['worker-src'] = this.validateSources(sources);
    return this;
  }

  setChildSrc(...sources: string[]): this {
    this.directives['child-src'] = this.validateSources(sources);
    return this;
  }

  setManifestSrc(...sources: string[]): this {
    this.directives['manifest-src'] = this.validateSources(sources);
    return this;
  }

  // Special directives
  requireSriFor(...types: string[]): this {
    this.directives['require-sri-for'] = types;
    return this;
  }

  requireTrustedTypesFor(...types: string[]): this {
    this.directives['require-trusted-types-for'] = types;
    return this;
  }

  trustedTypes(...policies: string[]): this {
    this.directives['trusted-types'] = policies;
    return this;
  }

  upgradeInsecureRequests(): this {
    this.directives['upgrade-insecure-requests'] = [];
    return this;
  }

  blockAllMixedContent(): this {
    this.directives['block-all-mixed-content'] = [];
    return this;
  }

  // Reporting configuration
  setReportUri(uri: string): this {
    this.reportUri = uri;
    return this;
  }

  setReportTo(endpoint: string): this {
    this.directives['report-to'] = [endpoint];
    return this;
  }

  enableReportOnly(): this {
    this.reportOnly = true;
    return this;
  }

  // Nonce and hash support
  addScriptNonce(nonce: string): this {
    const scriptSrc = this.directives['script-src'] || [];
    scriptSrc.push(`'nonce-${nonce}'`);
    this.directives['script-src'] = scriptSrc;
    return this;
  }

  addStyleNonce(nonce: string): this {
    const styleSrc = this.directives['style-src'] || [];
    styleSrc.push(`'nonce-${nonce}'`);
    this.directives['style-src'] = styleSrc;
    return this;
  }

  addScriptHash(algorithm: 'sha256' | 'sha384' | 'sha512', hash: string): this {
    const scriptSrc = this.directives['script-src'] || [];
    scriptSrc.push(`'${algorithm}-${hash}'`);
    this.directives['script-src'] = scriptSrc;
    return this;
  }

  addStyleHash(algorithm: 'sha256' | 'sha384' | 'sha512', hash: string): this {
    const styleSrc = this.directives['style-src'] || [];
    styleSrc.push(`'${algorithm}-${hash}'`);
    this.directives['style-src'] = styleSrc;
    return this;
  }

  // Validation
  private validateSources(sources: string[]): string[] {
    const validatedSources: string[] = [];
    
    for (const source of sources) {
      if (this.isValidSource(source)) {
        validatedSources.push(source);
      } else {
        console.warn(`Invalid CSP source: ${source}`);
      }
    }
    
    return validatedSources;
  }

  private isValidSource(source: string): boolean {
    // Special keywords
    const keywords = ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'none'", 
                     "'strict-dynamic'", "'unsafe-hashes'", "'report-sample'",
                     "'unsafe-allow-redirects'"];
    
    if (keywords.includes(source)) {
      return true;
    }
    
    // Nonce or hash
    if (source.match(/^'(nonce|sha256|sha384|sha512)-[A-Za-z0-9+/]+=*'$/)) {
      return true;
    }
    
    // URL scheme
    if (source.match(/^(https?|wss?|data|blob):$/)) {
      return true;
    }
    
    // Host source
    if (source.match(/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i)) {
      return true;
    }
    
    return false;
  }

  // Build the policy string
  build(): string {
    const directiveStrings: string[] = [];
    
    for (const [directive, sources] of Object.entries(this.directives)) {
      if (sources.length === 0) {
        directiveStrings.push(directive);
      } else {
        directiveStrings.push(`${directive} ${sources.join(' ')}`);
      }
    }
    
    if (this.reportUri) {
      directiveStrings.push(`report-uri ${this.reportUri}`);
    }
    
    return directiveStrings.join('; ');
  }

  // Get header name
  getHeaderName(): string {
    return this.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  }
}

// Production CSP configuration
export function createProductionCSP(nonce?: string): ContentSecurityPolicyBuilder {
  const csp = new ContentSecurityPolicyBuilder()
    .setScriptSrc("'self'", "'strict-dynamic'")
    .setStyleSrc("'self'", "'unsafe-inline'") // Consider using nonces for styles
    .setImgSrc("'self'", 'data:', 'https:')
    .setConnectSrc("'self'", 'https://api.example.com', 'wss://ws.example.com')
    .setFontSrc("'self'", 'https://fonts.gstatic.com')
    .setFrameSrc("'none'")
    .setWorkerSrc("'self'")
    .upgradeInsecureRequests()
    .blockAllMixedContent()
    .setReportUri('/api/csp-report')
    .setReportTo('csp-endpoint');

  if (nonce) {
    csp.addScriptNonce(nonce);
  }

  return csp;
}

// Development CSP configuration (more permissive)
export function createDevelopmentCSP(): ContentSecurityPolicyBuilder {
  return new ContentSecurityPolicyBuilder()
    .setScriptSrc("'self'", "'unsafe-inline'", "'unsafe-eval'", 'http://localhost:*')
    .setStyleSrc("'self'", "'unsafe-inline'")
    .setImgSrc("'self'", 'data:', 'http:', 'https:')
    .setConnectSrc("'self'", 'http://localhost:*', 'ws://localhost:*')
    .setFontSrc("'self'", 'data:')
    .setFrameSrc("'self'")
    .setWorkerSrc("'self'", 'blob:');
}
```

### Dynamic CSP with Nonce Generation

```typescript
// src/security/nonceGenerator.ts
import crypto from 'crypto';

export class NonceGenerator {
  private static readonly NONCE_LENGTH = 16;

  static generate(): string {
    return crypto.randomBytes(this.NONCE_LENGTH).toString('base64');
  }

  static generateForRequest(): { nonce: string; scriptTag: string; styleTag: string } {
    const nonce = this.generate();
    
    return {
      nonce,
      scriptTag: `<script nonce="${nonce}">`,
      styleTag: `<style nonce="${nonce}">`,
    };
  }
}

// Express middleware for CSP with nonce
export function cspMiddleware(req: Request, res: Response, next: NextFunction) {
  const nonce = NonceGenerator.generate();
  
  // Store nonce in res.locals for template rendering
  res.locals.nonce = nonce;
  
  // Build CSP with nonce
  const csp = createProductionCSP(nonce);
  
  // Set CSP header
  res.setHeader(csp.getHeaderName(), csp.build());
  
  next();
}

// React component for injecting nonce
export function NonceProvider({ nonce, children }: { nonce: string; children: React.ReactNode }) {
  return (
    <NonceContext.Provider value={nonce}>
      {children}
    </NonceContext.Provider>
  );
}

// Hook for using nonce in React components
export function useNonce(): string {
  const nonce = useContext(NonceContext);
  if (!nonce) {
    throw new Error('useNonce must be used within NonceProvider');
  }
  return nonce;
}
```

### CSP Violation Reporting

```typescript
// src/security/cspReporting.ts
interface CSPViolationReport {
  'csp-report': {
    'document-uri': string;
    'referrer': string;
    'violated-directive': string;
    'effective-directive': string;
    'original-policy': string;
    'disposition': string;
    'blocked-uri': string;
    'line-number'?: number;
    'column-number'?: number;
    'source-file'?: string;
    'status-code': number;
    'script-sample'?: string;
  };
}

export class CSPReportHandler {
  private violations: CSPViolationReport[] = [];
  private reportEndpoint: string;

  constructor(reportEndpoint: string) {
    this.reportEndpoint = reportEndpoint;
  }

  async handleReport(report: CSPViolationReport): Promise<void> {
    // Validate report
    if (!this.isValidReport(report)) {
      console.warn('Invalid CSP report received');
      return;
    }

    // Store violation
    this.violations.push(report);

    // Analyze violation
    const analysis = this.analyzeViolation(report);

    // Log for monitoring
    console.error('CSP Violation:', {
      directive: report['csp-report']['violated-directive'],
      blockedUri: report['csp-report']['blocked-uri'],
      documentUri: report['csp-report']['document-uri'],
      analysis,
    });

    // Send to monitoring service
    await this.sendToMonitoring(report, analysis);

    // Check for patterns
    this.checkViolationPatterns();
  }

  private isValidReport(report: any): report is CSPViolationReport {
    return report && 
           typeof report === 'object' && 
           'csp-report' in report &&
           typeof report['csp-report'] === 'object' &&
           'violated-directive' in report['csp-report'] &&
           'blocked-uri' in report['csp-report'];
  }

  private analyzeViolation(report: CSPViolationReport): {
    severity: 'low' | 'medium' | 'high' | 'critical';
    category: string;
    recommendation: string;
  } {
    const violation = report['csp-report'];
    
    // Determine severity based on directive
    let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
    let category = 'unknown';
    let recommendation = '';

    if (violation['violated-directive'].startsWith('script-src')) {
      severity = 'critical';
      category = 'script-injection';
      recommendation = 'Review script sources and update CSP if legitimate';
    } else if (violation['violated-directive'].startsWith('style-src')) {
      severity = 'medium';
      category = 'style-injection';
      recommendation = 'Consider using nonces for inline styles';
    } else if (violation['violated-directive'].startsWith('img-src')) {
      severity = 'low';
      category = 'image-loading';
      recommendation = 'Verify image source is trusted';
    } else if (violation['violated-directive'].startsWith('connect-src')) {
      severity = 'high';
      category = 'api-connection';
      recommendation = 'Audit API endpoints and update CSP if needed';
    }

    // Check for known attack patterns
    if (this.isKnownAttackPattern(violation['blocked-uri'])) {
      severity = 'critical';
      category = 'attack-attempt';
      recommendation = 'Potential attack detected - investigate immediately';
    }

    return { severity, category, recommendation };
  }

  private isKnownAttackPattern(blockedUri: string): boolean {
    const attackPatterns = [
      /javascript:/i,
      /data:text\/html/i,
      /vbscript:/i,
      /file:\/\//i,
      /chrome-extension:/i,
    ];

    return attackPatterns.some(pattern => pattern.test(blockedUri));
  }

  private async sendToMonitoring(
    report: CSPViolationReport, 
    analysis: any
  ): Promise<void> {
    try {
      await fetch(this.reportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report,
          analysis,
          timestamp: new Date().toISOString(),
          userAgent: report['csp-report']['document-uri'],
        }),
      });
    } catch (error) {
      console.error('Failed to send CSP report to monitoring:', error);
    }
  }

  private checkViolationPatterns(): void {
    // Check for repeated violations
    const recentViolations = this.violations.slice(-100);
    const violationCounts = new Map<string, number>();

    for (const violation of recentViolations) {
      const key = `${violation['csp-report']['violated-directive']}:${violation['csp-report']['blocked-uri']}`;
      violationCounts.set(key, (violationCounts.get(key) || 0) + 1);
    }

    // Alert on repeated violations
    for (const [key, count] of violationCounts) {
      if (count > 10) {
        console.warn(`Repeated CSP violation detected: ${key} (${count} times)`);
        // Trigger alert
        this.triggerAlert(key, count);
      }
    }
  }

  private triggerAlert(violation: string, count: number): void {
    // Implement alerting mechanism
    console.error(`ALERT: CSP violation threshold exceeded for ${violation}`);
  }
}
```

## CORS Configuration Best Practices

Cross-Origin Resource Sharing (CORS) is crucial for controlling access to your resources from different origins while maintaining security.

### Advanced CORS Implementation

```typescript
// src/security/cors.ts
interface CORSOptions {
  origins: string[] | ((origin: string) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
  preflightContinue?: boolean;
  optionsSuccessStatus?: number;
}

export class CORSManager {
  private options: CORSOptions;
  private allowedOrigins: Set<string> = new Set();

  constructor(options: CORSOptions) {
    this.options = {
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      exposedHeaders: ['X-Total-Count', 'X-Page-Number'],
      credentials: true,
      maxAge: 86400, // 24 hours
      preflightContinue: false,
      optionsSuccessStatus: 204,
      ...options,
    };

    if (Array.isArray(options.origins)) {
      options.origins.forEach(origin => this.allowedOrigins.add(origin));
    }
  }

  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      const origin = req.headers.origin;

      if (!origin) {
        // Same-origin request
        next();
        return;
      }

      // Check if origin is allowed
      if (this.isOriginAllowed(origin)) {
        this.setHeaders(res, origin);
      } else {
        // Log blocked origin for monitoring
        console.warn(`CORS: Blocked request from origin: ${origin}`);
      }

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        if (this.options.preflightContinue) {
          next();
        } else {
          res.sendStatus(this.options.optionsSuccessStatus!);
        }
      } else {
        next();
      }
    };
  }

  private isOriginAllowed(origin: string): boolean {
    if (typeof this.options.origins === 'function') {
      return this.options.origins(origin);
    }

    // Check exact match
    if (this.allowedOrigins.has(origin)) {
      return true;
    }

    // Check wildcard subdomain matching
    for (const allowed of this.allowedOrigins) {
      if (allowed.startsWith('*.')) {
        const domain = allowed.substring(2);
        const regex = new RegExp(`^https?://[^.]+\\.${domain.replace('.', '\\.')}$`);
        if (regex.test(origin)) {
          return true;
        }
      }
    }

    return false;
  }

  private setHeaders(res: Response, origin: string): void {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');

    if (this.options.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (this.options.methods) {
      res.setHeader('Access-Control-Allow-Methods', this.options.methods.join(', '));
    }

    if (this.options.allowedHeaders) {
      res.setHeader('Access-Control-Allow-Headers', this.options.allowedHeaders.join(', '));
    }

    if (this.options.exposedHeaders) {
      res.setHeader('Access-Control-Expose-Headers', this.options.exposedHeaders.join(', '));
    }

    if (this.options.maxAge) {
      res.setHeader('Access-Control-Max-Age', this.options.maxAge.toString());
    }
  }

  // Dynamic origin validation
  static createDynamicOriginValidator(config: {
    allowedDomains: string[];
    allowLocalhost?: boolean;
    allowSubdomains?: boolean;
  }): (origin: string) => boolean {
    return (origin: string) => {
      try {
        const url = new URL(origin);
        
        // Allow localhost in development
        if (config.allowLocalhost && url.hostname === 'localhost') {
          return true;
        }

        // Check allowed domains
        for (const domain of config.allowedDomains) {
          if (config.allowSubdomains) {
            if (url.hostname === domain || url.hostname.endsWith(`.${domain}`)) {
              return true;
            }
          } else {
            if (url.hostname === domain) {
              return true;
            }
          }
        }

        return false;
      } catch {
        return false;
      }
    };
  }
}

// Production CORS configuration
export const productionCORS = new CORSManager({
  origins: CORSManager.createDynamicOriginValidator({
    allowedDomains: ['example.com', 'app.example.com'],
    allowLocalhost: false,
    allowSubdomains: true,
  }),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  exposedHeaders: ['X-Total-Count', 'X-RateLimit-Remaining'],
});

// Development CORS configuration
export const developmentCORS = new CORSManager({
  origins: CORSManager.createDynamicOriginValidator({
    allowedDomains: ['localhost', '127.0.0.1'],
    allowLocalhost: true,
    allowSubdomains: false,
  }),
  credentials: true,
});
```

### CORS Security Patterns

```typescript
// src/security/corsPatterns.ts
export class CORSSecurityPatterns {
  // Pattern 1: Whitelist with environment-based configuration
  static createEnvironmentBasedCORS(): CORSManager {
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    
    return new CORSManager({
      origins: (origin) => {
        // Always allow same-origin requests
        if (!origin) return true;
        
        // Check whitelist
        return allowedOrigins.some(allowed => {
          if (allowed === origin) return true;
          
          // Support wildcard subdomains
          if (allowed.startsWith('*.')) {
            const domain = allowed.substring(2);
            const regex = new RegExp(`^https?://[^.]+\\.${domain.replace('.', '\\.')}$`);
            return regex.test(origin);
          }
          
          return false;
        });
      },
      credentials: true,
    });
  }

  // Pattern 2: Token-based CORS validation
  static createTokenBasedCORS(validateToken: (token: string) => Promise<boolean>): CORSManager {
    return new CORSManager({
      origins: async (origin) => {
        // Extract token from request
        const token = this.extractTokenFromOrigin(origin);
        
        if (!token) return false;
        
        // Validate token
        return await validateToken(token);
      },
      credentials: false, // Don't use cookies with token-based auth
    });
  }

  // Pattern 3: Time-based CORS restrictions
  static createTimeBasedCORS(allowedOrigins: string[], restrictedHours?: {
    start: number;
    end: number;
  }): CORSManager {
    return new CORSManager({
      origins: (origin) => {
        if (!allowedOrigins.includes(origin)) {
          return false;
        }
        
        if (restrictedHours) {
          const hour = new Date().getHours();
          if (hour >= restrictedHours.start && hour < restrictedHours.end) {
            console.warn(`CORS: Access restricted during hours ${restrictedHours.start}-${restrictedHours.end}`);
            return false;
          }
        }
        
        return true;
      },
    });
  }

  // Pattern 4: Rate-limited CORS
  static createRateLimitedCORS(
    allowedOrigins: string[],
    rateLimit: { windowMs: number; max: number }
  ): CORSManager {
    const requestCounts = new Map<string, { count: number; resetTime: number }>();
    
    return new CORSManager({
      origins: (origin) => {
        if (!allowedOrigins.includes(origin)) {
          return false;
        }
        
        const now = Date.now();
        const record = requestCounts.get(origin) || { count: 0, resetTime: now + rateLimit.windowMs };
        
        if (now > record.resetTime) {
          // Reset window
          record.count = 0;
          record.resetTime = now + rateLimit.windowMs;
        }
        
        record.count++;
        requestCounts.set(origin, record);
        
        if (record.count > rateLimit.max) {
          console.warn(`CORS: Rate limit exceeded for origin ${origin}`);
          return false;
        }
        
        return true;
      },
    });
  }

  private static extractTokenFromOrigin(origin: string): string | null {
    // Example: Extract token from subdomain
    const match = origin.match(/^https?:\/\/([^.]+)\.api\.example\.com$/);
    return match ? match[1] : null;
  }
}
```

## XSS Prevention Techniques

Cross-Site Scripting remains one of the most dangerous vulnerabilities. Here's a comprehensive approach to preventing XSS attacks.

### Input Validation and Sanitization

```typescript
// src/security/xss.ts
import DOMPurify from 'isomorphic-dompurify';
import { z } from 'zod';

export class XSSProtection {
  private static readonly DANGEROUS_TAGS = [
    'script', 'iframe', 'object', 'embed', 'link', 'style', 'form', 'input', 
    'button', 'select', 'textarea', 'meta', 'base'
  ];

  private static readonly DANGEROUS_ATTRIBUTES = [
    'onload', 'onerror', 'onclick', 'onmouseover', 'onmouseout', 'onkeydown',
    'onkeyup', 'onchange', 'onfocus', 'onblur', 'onsubmit', 'ondblclick',
    'onmouseenter', 'onmouseleave', 'oncontextmenu', 'formaction', 'style'
  ];

  // Sanitize HTML content
  static sanitizeHTML(dirty: string, options?: {
    allowedTags?: string[];
    allowedAttributes?: string[];
    allowDataAttributes?: boolean;
  }): string {
    const config: any = {
      ALLOWED_TAGS: options?.allowedTags || ['p', 'br', 'span', 'div', 'a', 'strong', 'em', 'ul', 'ol', 'li'],
      ALLOWED_ATTR: options?.allowedAttributes || ['href', 'title', 'class'],
      ALLOW_DATA_ATTR: options?.allowDataAttributes || false,
      RETURN_TRUSTED_TYPE: false,
    };

    // Additional security: Remove dangerous protocols
    config.ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

    return DOMPurify.sanitize(dirty, config);
  }

  // Escape HTML entities
  static escapeHTML(unsafe: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
    };

    return unsafe.replace(/[&<>"'/]/g, (char) => map[char]);
  }

  // Validate and sanitize JSON
  static sanitizeJSON(input: any): any {
    if (typeof input === 'string') {
      try {
        // Parse and re-stringify to remove any code
        return JSON.parse(JSON.stringify(JSON.parse(input)));
      } catch {
        throw new Error('Invalid JSON input');
      }
    }
    
    // Deep clone and sanitize object
    return this.deepSanitizeObject(input);
  }

  private static deepSanitizeObject(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.deepSanitizeObject(item));
    }

    const sanitized: any = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // Skip prototype pollution attempts
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      
      // Sanitize key
      const sanitizedKey = this.escapeHTML(key);
      
      // Recursively sanitize value
      if (typeof value === 'string') {
        sanitized[sanitizedKey] = this.escapeHTML(value);
      } else if (typeof value === 'object') {
        sanitized[sanitizedKey] = this.deepSanitizeObject(value);
      } else {
        sanitized[sanitizedKey] = value;
      }
    }
    
    return sanitized;
  }

  // URL validation and sanitization
  static sanitizeURL(url: string): string {
    try {
      const parsed = new URL(url);
      
      // Only allow safe protocols
      const safeProtocols = ['http:', 'https:', 'mailto:'];
      if (!safeProtocols.includes(parsed.protocol)) {
        throw new Error('Unsafe protocol');
      }
      
      // Reconstruct URL to remove any injected code
      return parsed.toString();
    } catch {
      // If URL parsing fails, return empty string
      return '';
    }
  }

  // Create safe HTML templates
  static createSafeTemplate(strings: TemplateStringsArray, ...values: any[]): string {
    let result = '';
    
    for (let i = 0; i < strings.length; i++) {
      result += strings[i];
      
      if (i < values.length) {
        // Escape all interpolated values
        result += this.escapeHTML(String(values[i]));
      }
    }
    
    return result;
  }

  // Schema-based validation
  static createValidator<T>(schema: z.ZodSchema<T>) {
    return (data: unknown): T => {
      try {
        // Validate against schema
        const validated = schema.parse(data);
        
        // Additional sanitization
        return this.deepSanitizeObject(validated) as T;
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(`Validation failed: ${error.errors.map(e => e.message).join(', ')}`);
        }
        throw error;
      }
    };
  }
}

// React component for safe rendering
export function SafeHTML({ 
  content, 
  allowedTags,
  allowedAttributes,
  className 
}: {
  content: string;
  allowedTags?: string[];
  allowedAttributes?: string[];
  className?: string;
}) {
  const sanitized = XSSProtection.sanitizeHTML(content, {
    allowedTags,
    allowedAttributes,
  });

  return (
    <div 
      className={className}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}

// Hook for XSS protection
export function useXSSProtection() {
  const sanitizeInput = useCallback((input: string) => {
    return XSSProtection.escapeHTML(input);
  }, []);

  const sanitizeHTML = useCallback((html: string, options?: any) => {
    return XSSProtection.sanitizeHTML(html, options);
  }, []);

  const sanitizeURL = useCallback((url: string) => {
    return XSSProtection.sanitizeURL(url);
  }, []);

  return {
    sanitizeInput,
    sanitizeHTML,
    sanitizeURL,
  };
}
```

### DOM-based XSS Prevention

```typescript
// src/security/domXssPrevention.ts
export class DOMXSSPrevention {
  // Safe DOM manipulation
  static setText(element: HTMLElement, text: string): void {
    element.textContent = text; // Always safe
  }

  static setHTML(element: HTMLElement, html: string): void {
    // Use DOMPurify for HTML content
    const clean = DOMPurify.sanitize(html);
    element.innerHTML = clean;
  }

  static setAttribute(element: HTMLElement, name: string, value: string): void {
    // Validate attribute name
    if (this.isDangerousAttribute(name)) {
      console.error(`Blocked dangerous attribute: ${name}`);
      return;
    }

    // Special handling for certain attributes
    if (name === 'href' || name === 'src') {
      const sanitized = XSSProtection.sanitizeURL(value);
      if (sanitized) {
        element.setAttribute(name, sanitized);
      }
    } else {
      element.setAttribute(name, XSSProtection.escapeHTML(value));
    }
  }

  private static isDangerousAttribute(name: string): boolean {
    return name.startsWith('on') || name === 'formaction' || name === 'style';
  }

  // Safe element creation
  static createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    options?: {
      text?: string;
      html?: string;
      attributes?: Record<string, string>;
      children?: HTMLElement[];
    }
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);

    if (options?.text) {
      this.setText(element, options.text);
    } else if (options?.html) {
      this.setHTML(element, options.html);
    }

    if (options?.attributes) {
      for (const [name, value] of Object.entries(options.attributes)) {
        this.setAttribute(element, name, value);
      }
    }

    if (options?.children) {
      for (const child of options.children) {
        element.appendChild(child);
      }
    }

    return element;
  }

  // Safe event handler attachment
  static addEventListener(
    element: HTMLElement,
    event: string,
    handler: EventListener,
    options?: AddEventListenerOptions
  ): void {
    // Validate event type
    const allowedEvents = [
      'click', 'dblclick', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout',
      'keydown', 'keyup', 'keypress', 'focus', 'blur', 'change', 'input',
      'submit', 'load', 'error', 'resize', 'scroll'
    ];

    if (!allowedEvents.includes(event)) {
      console.warn(`Potentially dangerous event type: ${event}`);
    }

    element.addEventListener(event, handler, options);
  }

  // Safe URL manipulation
  static updateURL(url: string, params?: Record<string, string>): string {
    try {
      const urlObj = new URL(url, window.location.origin);
      
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          urlObj.searchParams.set(
            XSSProtection.escapeHTML(key),
            XSSProtection.escapeHTML(value)
          );
        }
      }
      
      return urlObj.toString();
    } catch {
      return '';
    }
  }
}

// React hook for safe DOM operations
export function useSafeDOM() {
  const setTextContent = useCallback((ref: React.RefObject<HTMLElement>, text: string) => {
    if (ref.current) {
      DOMXSSPrevention.setText(ref.current, text);
    }
  }, []);

  const setHTMLContent = useCallback((ref: React.RefObject<HTMLElement>, html: string) => {
    if (ref.current) {
      DOMXSSPrevention.setHTML(ref.current, html);
    }
  }, []);

  const setSafeAttribute = useCallback((
    ref: React.RefObject<HTMLElement>, 
    name: string, 
    value: string
  ) => {
    if (ref.current) {
      DOMXSSPrevention.setAttribute(ref.current, name, value);
    }
  }, []);

  return {
    setTextContent,
    setHTMLContent,
    setSafeAttribute,
  };
}
```

## Authentication and Authorization Patterns

Implementing secure authentication and authorization is crucial for protecting your application.

### JWT-based Authentication with Security Best Practices

```typescript
// src/auth/jwtAuth.ts
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const TokenPayloadSchema = z.object({
  sub: z.string(), // Subject (user ID)
  email: z.string().email(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  iat: z.number(),
  exp: z.number(),
  jti: z.string(), // JWT ID for revocation
});

type TokenPayload = z.infer<typeof TokenPayloadSchema>;

export class JWTAuthManager {
  private readonly accessTokenSecret: string;
  private readonly refreshTokenSecret: string;
  private readonly accessTokenExpiry: string;
  private readonly refreshTokenExpiry: string;
  private readonly issuer: string;
  private readonly audience: string;
  private revokedTokens: Set<string> = new Set();

  constructor(config: {
    accessTokenSecret: string;
    refreshTokenSecret: string;
    accessTokenExpiry?: string;
    refreshTokenExpiry?: string;
    issuer: string;
    audience: string;
  }) {
    this.accessTokenSecret = config.accessTokenSecret;
    this.refreshTokenSecret = config.refreshTokenSecret;
    this.accessTokenExpiry = config.accessTokenExpiry || '15m';
    this.refreshTokenExpiry = config.refreshTokenExpiry || '7d';
    this.issuer = config.issuer;
    this.audience = config.audience;
  }

  generateTokenPair(user: {
    id: string;
    email: string;
    roles: string[];
    permissions: string[];
  }): {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  } {
    const jti = this.generateJTI();
    const now = Math.floor(Date.now() / 1000);

    const payload: TokenPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      permissions: user.permissions,
      iat: now,
      exp: now + this.parseExpiry(this.accessTokenExpiry),
      jti,
    };

    const accessToken = jwt.sign(payload, this.accessTokenSecret, {
      algorithm: 'HS256',
      issuer: this.issuer,
      audience: this.audience,
    });

    const refreshPayload = {
      sub: user.id,
      jti: this.generateJTI(),
      iat: now,
      exp: now + this.parseExpiry(this.refreshTokenExpiry),
    };

    const refreshToken = jwt.sign(refreshPayload, this.refreshTokenSecret, {
      algorithm: 'HS256',
      issuer: this.issuer,
      audience: this.audience,
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: payload.exp - now,
    };
  }

  verifyAccessToken(token: string): TokenPayload {
    try {
      const decoded = jwt.verify(token, this.accessTokenSecret, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as any;

      // Validate payload structure
      const payload = TokenPayloadSchema.parse(decoded);

      // Check if token is revoked
      if (this.revokedTokens.has(payload.jti)) {
        throw new Error('Token has been revoked');
      }

      return payload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Token expired');
      } else if (error instanceof jwt.JsonWebTokenError) {
        throw new Error('Invalid token');
      }
      throw error;
    }
  }

  verifyRefreshToken(token: string): { sub: string; jti: string } {
    try {
      const decoded = jwt.verify(token, this.refreshTokenSecret, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
      }) as any;

      if (this.revokedTokens.has(decoded.jti)) {
        throw new Error('Refresh token has been revoked');
      }

      return {
        sub: decoded.sub,
        jti: decoded.jti,
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Refresh token expired');
      }
      throw new Error('Invalid refresh token');
    }
  }

  revokeToken(jti: string): void {
    this.revokedTokens.add(jti);
    
    // In production, store in Redis or database
    // this.redis.sadd('revoked_tokens', jti);
  }

  private generateJTI(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private parseExpiry(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error('Invalid expiry format');
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 60 * 60;
      case 'd': return value * 60 * 60 * 24;
      default: throw new Error('Invalid expiry unit');
    }
  }
}

// Express middleware for JWT authentication
export function jwtAuthMiddleware(authManager: JWTAuthManager) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);

    try {
      const payload = authManager.verifyAccessToken(token);
      (req as any).user = payload;
      next();
    } catch (error) {
      return res.status(401).json({ error: error.message });
    }
  };
}

// React hook for JWT authentication
export function useJWTAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<TokenPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    
    if (token) {
      try {
        // Decode token without verification (for client-side)
        const decoded = jwt.decode(token) as TokenPayload;
        
        if (decoded && decoded.exp > Date.now() / 1000) {
          setUser(decoded);
          setIsAuthenticated(true);
        } else {
          // Token expired, try refresh
          refreshToken();
        }
      } catch {
        setIsAuthenticated(false);
      }
    }
    
    setLoading(false);
  }, []);

  const login = async (credentials: { email: string; password: string }) => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });

      if (!response.ok) {
        throw new Error('Login failed');
      }

      const { accessToken, refreshToken } = await response.json();
      
      localStorage.setItem('access_token', accessToken);
      localStorage.setItem('refresh_token', refreshToken);
      
      const decoded = jwt.decode(accessToken) as TokenPayload;
      setUser(decoded);
      setIsAuthenticated(true);
    } catch (error) {
      throw error;
    }
  };

  const logout = () => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    setUser(null);
    setIsAuthenticated(false);
  };

  const refreshToken = async () => {
    try {
      const refreshToken = localStorage.getItem('refresh_token');
      if (!refreshToken) {
        throw new Error('No refresh token');
      }

      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        throw new Error('Token refresh failed');
      }

      const { accessToken } = await response.json();
      localStorage.setItem('access_token', accessToken);
      
      const decoded = jwt.decode(accessToken) as TokenPayload;
      setUser(decoded);
      setIsAuthenticated(true);
    } catch {
      logout();
    }
  };

  return {
    isAuthenticated,
    user,
    loading,
    login,
    logout,
    refreshToken,
  };
}
```

### Role-Based Access Control (RBAC)

```typescript
// src/auth/rbac.ts
interface Permission {
  resource: string;
  action: string;
  conditions?: Record<string, any>;
}

interface Role {
  name: string;
  permissions: Permission[];
}

export class RBACManager {
  private roles: Map<string, Role> = new Map();
  private userRoles: Map<string, string[]> = new Map();

  constructor() {
    this.initializeDefaultRoles();
  }

  private initializeDefaultRoles(): void {
    // Define default roles
    this.addRole({
      name: 'admin',
      permissions: [
        { resource: '*', action: '*' }, // Full access
      ],
    });

    this.addRole({
      name: 'editor',
      permissions: [
        { resource: 'posts', action: 'create' },
        { resource: 'posts', action: 'read' },
        { resource: 'posts', action: 'update' },
        { resource: 'posts', action: 'delete', conditions: { own: true } },
        { resource: 'media', action: '*' },
      ],
    });

    this.addRole({
      name: 'viewer',
      permissions: [
        { resource: 'posts', action: 'read' },
        { resource: 'media', action: 'read' },
      ],
    });
  }

  addRole(role: Role): void {
    this.roles.set(role.name, role);
  }

  assignRole(userId: string, roleName: string): void {
    const roles = this.userRoles.get(userId) || [];
    if (!roles.includes(roleName)) {
      roles.push(roleName);
      this.userRoles.set(userId, roles);
    }
  }

  removeRole(userId: string, roleName: string): void {
    const roles = this.userRoles.get(userId) || [];
    const filtered = roles.filter(r => r !== roleName);
    this.userRoles.set(userId, filtered);
  }

  hasPermission(
    userId: string, 
    resource: string, 
    action: string, 
    context?: Record<string, any>
  ): boolean {
    const userRoleNames = this.userRoles.get(userId) || [];
    
    for (const roleName of userRoleNames) {
      const role = this.roles.get(roleName);
      if (!role) continue;
      
      for (const permission of role.permissions) {
        if (this.matchesPermission(permission, resource, action, context)) {
          return true;
        }
      }
    }
    
    return false;
  }

  private matchesPermission(
    permission: Permission,
    resource: string,
    action: string,
    context?: Record<string, any>
  ): boolean {
    // Check resource match
    if (permission.resource !== '*' && permission.resource !== resource) {
      return false;
    }
    
    // Check action match
    if (permission.action !== '*' && permission.action !== action) {
      return false;
    }
    
    // Check conditions
    if (permission.conditions && context) {
      for (const [key, value] of Object.entries(permission.conditions)) {
        if (context[key] !== value) {
          return false;
        }
      }
    }
    
    return true;
  }

  getUserPermissions(userId: string): Permission[] {
    const userRoleNames = this.userRoles.get(userId) || [];
    const permissions: Permission[] = [];
    
    for (const roleName of userRoleNames) {
      const role = this.roles.get(roleName);
      if (role) {
        permissions.push(...role.permissions);
      }
    }
    
    return permissions;
  }
}

// React component for role-based access
export function RequirePermission({ 
  resource, 
  action, 
  children,
  fallback = null
}: {
  resource: string;
  action: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { user } = useJWTAuth();
  const rbac = useContext(RBACContext);
  
  if (!user || !rbac.hasPermission(user.sub, resource, action)) {
    return <>{fallback}</>;
  }
  
  return <>{children}</>;
}

// Hook for checking permissions
export function usePermission(resource: string, action: string): boolean {
  const { user } = useJWTAuth();
  const rbac = useContext(RBACContext);
  
  if (!user) return false;
  
  return rbac.hasPermission(user.sub, resource, action);
}
```

## Security Headers Configuration

Implementing comprehensive security headers is crucial for protecting your application.

```typescript
// src/security/headers.ts
export class SecurityHeaders {
  static getProductionHeaders(): Record<string, string> {
    return {
      // CSP is handled separately with nonce support
      
      // Strict Transport Security
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      
      // Prevent MIME type sniffing
      'X-Content-Type-Options': 'nosniff',
      
      // XSS Protection (legacy browsers)
      'X-XSS-Protection': '1; mode=block',
      
      // Clickjacking protection
      'X-Frame-Options': 'DENY',
      
      // Referrer Policy
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      
      // Permissions Policy (formerly Feature Policy)
      'Permissions-Policy': [
        'accelerometer=()',
        'autoplay=()',
        'camera=()',
        'encrypted-media=()',
        'fullscreen=(self)',
        'geolocation=(self)',
        'gyroscope=()',
        'magnetometer=()',
        'microphone=()',
        'midi=()',
        'payment=()',
        'picture-in-picture=()',
        'sync-xhr=()',
        'usb=()',
        'interest-cohort=()', // Opt out of FLoC
      ].join(', '),
      
      // Cross-Origin Policies
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      
      // Cache Control for sensitive pages
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      
      // Additional security headers
      'X-DNS-Prefetch-Control': 'off',
      'X-Download-Options': 'noopen',
      'X-Permitted-Cross-Domain-Policies': 'none',
    };
  }

  static getReportingEndpoints(): Record<string, string> {
    return {
      'Report-To': JSON.stringify([
        {
          group: 'csp-endpoint',
          max_age: 86400,
          endpoints: [{ url: '/api/security/csp-report' }],
        },
        {
          group: 'network-errors',
          max_age: 86400,
          endpoints: [{ url: '/api/security/network-error' }],
        },
        {
          group: 'deprecation',
          max_age: 86400,
          endpoints: [{ url: '/api/security/deprecation-report' }],
        },
      ]),
      
      'NEL': JSON.stringify({
        report_to: 'network-errors',
        max_age: 86400,
        include_subdomains: true,
      }),
    };
  }

  static applyToResponse(res: Response, options?: {
    noCacheHeaders?: boolean;
    additionalHeaders?: Record<string, string>;
  }): void {
    const headers = this.getProductionHeaders();
    const reportingHeaders = this.getReportingEndpoints();
    
    // Apply security headers
    for (const [name, value] of Object.entries(headers)) {
      // Skip cache headers if requested
      if (options?.noCacheHeaders && ['Cache-Control', 'Pragma', 'Expires'].includes(name)) {
        continue;
      }
      res.setHeader(name, value);
    }
    
    // Apply reporting headers
    for (const [name, value] of Object.entries(reportingHeaders)) {
      res.setHeader(name, value);
    }
    
    // Apply additional headers
    if (options?.additionalHeaders) {
      for (const [name, value] of Object.entries(options.additionalHeaders)) {
        res.setHeader(name, value);
      }
    }
    
    // Remove potentially dangerous headers
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
  }
}

// Express middleware
export function securityHeadersMiddleware(options?: any) {
  return (req: Request, res: Response, next: NextFunction) => {
    SecurityHeaders.applyToResponse(res, options);
    next();
  };
}
```

## Vulnerability Scanning and Testing

Implementing automated security testing ensures ongoing protection.

```typescript
// src/security/vulnerabilityScanner.ts
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class VulnerabilityScanner {
  // Dependency scanning
  static async scanDependencies(): Promise<{
    vulnerabilities: any[];
    summary: {
      total: number;
      high: number;
      medium: number;
      low: number;
    };
  }> {
    try {
      // Run npm audit
      const { stdout } = await execAsync('npm audit --json');
      const auditResult = JSON.parse(stdout);
      
      const vulnerabilities = Object.values(auditResult.vulnerabilities || {});
      
      const summary = {
        total: vulnerabilities.length,
        high: vulnerabilities.filter((v: any) => v.severity === 'high').length,
        medium: vulnerabilities.filter((v: any) => v.severity === 'moderate').length,
        low: vulnerabilities.filter((v: any) => v.severity === 'low').length,
      };
      
      return { vulnerabilities, summary };
    } catch (error) {
      console.error('Dependency scan failed:', error);
      throw error;
    }
  }

  // Static code analysis
  static async scanCode(): Promise<{
    issues: any[];
    stats: Record<string, number>;
  }> {
    const issues: any[] = [];
    const stats: Record<string, number> = {
      dangerouslySetInnerHTML: 0,
      eval: 0,
      innerHTML: 0,
      documentWrite: 0,
    };

    // Scan for dangerous patterns
    const dangerousPatterns = [
      {
        pattern: /dangerouslySetInnerHTML/g,
        type: 'dangerouslySetInnerHTML',
        severity: 'high',
        message: 'Use of dangerouslySetInnerHTML detected',
      },
      {
        pattern: /eval\s*\(/g,
        type: 'eval',
        severity: 'critical',
        message: 'Use of eval() detected',
      },
      {
        pattern: /\.innerHTML\s*=/g,
        type: 'innerHTML',
        severity: 'high',
        message: 'Direct innerHTML assignment detected',
      },
      {
        pattern: /document\.write/g,
        type: 'documentWrite',
        severity: 'medium',
        message: 'Use of document.write detected',
      },
    ];

    // Scan files
    const { stdout } = await execAsync('find src -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx"');
    const files = stdout.trim().split('\n');

    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      
      for (const { pattern, type, severity, message } of dangerousPatterns) {
        const matches = content.match(pattern);
        if (matches) {
          stats[type] += matches.length;
          
          matches.forEach((match, index) => {
            const line = content.substring(0, content.indexOf(match)).split('\n').length;
            
            issues.push({
              file,
              line,
              type,
              severity,
              message,
              code: match,
            });
          });
        }
      }
    }

    return { issues, stats };
  }

  // CSP validation
  static async validateCSP(url: string): Promise<{
    valid: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    try {
      const response = await fetch(url, { method: 'HEAD' });
      const cspHeader = response.headers.get('content-security-policy');

      if (!cspHeader) {
        issues.push('No Content-Security-Policy header found');
        recommendations.push('Add a Content-Security-Policy header');
        return { valid: false, issues, recommendations };
      }

      // Parse CSP
      const directives = cspHeader.split(';').map(d => d.trim());
      const directiveMap = new Map<string, string>();

      for (const directive of directives) {
        const [name, ...values] = directive.split(' ');
        directiveMap.set(name, values.join(' '));
      }

      // Check for unsafe directives
      if (directiveMap.get('script-src')?.includes("'unsafe-inline'")) {
        issues.push("script-src contains 'unsafe-inline'");
        recommendations.push("Use nonces or hashes instead of 'unsafe-inline'");
      }

      if (directiveMap.get('script-src')?.includes("'unsafe-eval'")) {
        issues.push("script-src contains 'unsafe-eval'");
        recommendations.push("Remove 'unsafe-eval' and refactor code to avoid eval()");
      }

      // Check for missing directives
      const requiredDirectives = ['default-src', 'script-src', 'style-src', 'img-src'];
      for (const required of requiredDirectives) {
        if (!directiveMap.has(required)) {
          issues.push(`Missing ${required} directive`);
          recommendations.push(`Add ${required} directive to CSP`);
        }
      }

      return {
        valid: issues.length === 0,
        issues,
        recommendations,
      };
    } catch (error) {
      issues.push(`Failed to validate CSP: ${error.message}`);
      return { valid: false, issues, recommendations };
    }
  }
}

// Automated security testing
export async function runSecurityTests(): Promise<{
  passed: boolean;
  results: any;
}> {
  const results = {
    dependencies: await VulnerabilityScanner.scanDependencies(),
    code: await VulnerabilityScanner.scanCode(),
    csp: await VulnerabilityScanner.validateCSP(process.env.APP_URL || 'http://localhost:3000'),
  };

  const passed = 
    results.dependencies.summary.high === 0 &&
    results.code.issues.filter(i => i.severity === 'critical').length === 0 &&
    results.csp.valid;

  return { passed, results };
}
```

## Security Monitoring and Incident Response

```typescript
// src/security/monitoring.ts
export class SecurityMonitor {
  private incidents: SecurityIncident[] = [];
  private alertHandlers: AlertHandler[] = [];

  constructor() {
    this.setupMonitoring();
  }

  private setupMonitoring(): void {
    // Monitor for suspicious activities
    this.monitorFailedLogins();
    this.monitorCSPViolations();
    this.monitorRateLimits();
    this.monitorAnomalousPatterns();
  }

  private monitorFailedLogins(): void {
    // Track failed login attempts
    const failedAttempts = new Map<string, number>();
    
    setInterval(() => {
      for (const [ip, count] of failedAttempts) {
        if (count > 5) {
          this.createIncident({
            type: 'brute-force',
            severity: 'high',
            description: `Multiple failed login attempts from ${ip}`,
            metadata: { ip, attempts: count },
          });
        }
      }
      
      // Reset counters
      failedAttempts.clear();
    }, 60000); // Check every minute
  }

  private monitorCSPViolations(): void {
    // Aggregate CSP violations
    const violations = new Map<string, number>();
    
    setInterval(() => {
      for (const [directive, count] of violations) {
        if (count > 100) {
          this.createIncident({
            type: 'csp-violation-spike',
            severity: 'medium',
            description: `Spike in CSP violations for ${directive}`,
            metadata: { directive, count },
          });
        }
      }
      
      violations.clear();
    }, 300000); // Check every 5 minutes
  }

  private monitorRateLimits(): void {
    // Monitor for rate limit violations
    const rateLimitViolations = new Map<string, number>();
    
    setInterval(() => {
      for (const [endpoint, count] of rateLimitViolations) {
        if (count > 50) {
          this.createIncident({
            type: 'rate-limit-abuse',
            severity: 'medium',
            description: `Rate limit abuse on ${endpoint}`,
            metadata: { endpoint, violations: count },
          });
        }
      }
      
      rateLimitViolations.clear();
    }, 60000);
  }

  private monitorAnomalousPatterns(): void {
    // Monitor for unusual patterns
    setInterval(() => {
      // Check for suspicious user agents
      // Check for unusual request patterns
      // Check for potential scanning activities
    }, 300000);
  }

  createIncident(incident: Omit<SecurityIncident, 'id' | 'timestamp'>): void {
    const fullIncident: SecurityIncident = {
      id: generateId(),
      timestamp: new Date(),
      ...incident,
    };
    
    this.incidents.push(fullIncident);
    
    // Trigger alerts
    for (const handler of this.alertHandlers) {
      if (handler.shouldAlert(fullIncident)) {
        handler.alert(fullIncident);
      }
    }
  }

  addAlertHandler(handler: AlertHandler): void {
    this.alertHandlers.push(handler);
  }

  getIncidents(filter?: {
    type?: string;
    severity?: string;
    since?: Date;
  }): SecurityIncident[] {
    return this.incidents.filter(incident => {
      if (filter?.type && incident.type !== filter.type) return false;
      if (filter?.severity && incident.severity !== filter.severity) return false;
      if (filter?.since && incident.timestamp < filter.since) return false;
      return true;
    });
  }
}

interface SecurityIncident {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  timestamp: Date;
  metadata?: any;
}

interface AlertHandler {
  shouldAlert(incident: SecurityIncident): boolean;
  alert(incident: SecurityIncident): void;
}

// Email alert handler
export class EmailAlertHandler implements AlertHandler {
  constructor(private emailService: any) {}

  shouldAlert(incident: SecurityIncident): boolean {
    return incident.severity === 'high' || incident.severity === 'critical';
  }

  alert(incident: SecurityIncident): void {
    this.emailService.send({
      to: 'security@example.com',
      subject: `Security Alert: ${incident.type}`,
      body: `
        Security incident detected:
        
        Type: ${incident.type}
        Severity: ${incident.severity}
        Time: ${incident.timestamp}
        Description: ${incident.description}
        
        Metadata: ${JSON.stringify(incident.metadata, null, 2)}
      `,
    });
  }
}

// Slack alert handler
export class SlackAlertHandler implements AlertHandler {
  constructor(private webhookUrl: string) {}

  shouldAlert(incident: SecurityIncident): boolean {
    return true; // Alert on all incidents
  }

  async alert(incident: SecurityIncident): Promise<void> {
    const color = {
      low: '#36a64f',
      medium: '#ff9900',
      high: '#ff0000',
      critical: '#800000',
    }[incident.severity];

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color,
          title: `Security Alert: ${incident.type}`,
          text: incident.description,
          fields: [
            {
              title: 'Severity',
              value: incident.severity.toUpperCase(),
              short: true,
            },
            {
              title: 'Time',
              value: incident.timestamp.toISOString(),
              short: true,
            },
          ],
          footer: 'Security Monitor',
          ts: Math.floor(incident.timestamp.getTime() / 1000),
        }],
      }),
    });
  }
}
```

## Conclusion

Frontend security is a multi-layered challenge that requires constant vigilance and a comprehensive approach. Key takeaways from this guide include:

1. **Content Security Policy (CSP)** is your first line of defense against XSS attacks - implement it with nonces for maximum security
2. **CORS configuration** must be carefully managed to prevent unauthorized access while enabling legitimate cross-origin requests
3. **XSS prevention** requires multiple strategies including input validation, output encoding, and safe DOM manipulation
4. **Authentication and authorization** must be implemented with security-first principles, including proper token management and RBAC
5. **Security headers** provide crucial browser-level protections that should be configured for all applications
6. **Continuous monitoring and testing** ensure that security measures remain effective as your application evolves

Remember that security is not a one-time implementation but an ongoing process. Regular audits, updates, and monitoring are essential to maintain a robust security posture. By implementing these comprehensive security measures, you can significantly reduce the attack surface of your web applications and protect your users' data and privacy.