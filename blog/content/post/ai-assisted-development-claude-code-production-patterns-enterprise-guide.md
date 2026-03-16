---
title: "AI-Assisted Development with Claude Code: 50 Production Patterns for Enterprise Software Delivery"
date: 2026-04-22T00:00:00-05:00
draft: false
tags: ["ai-development", "claude-code", "productivity", "software-engineering", "automation", "devops", "best-practices", "llm"]
categories:
- Software Engineering
- AI Development
- Productivity
author: "Matthew Mattox - mmattox@support.tools"
description: "Master AI-assisted development with comprehensive Claude Code patterns and workflows. Complete guide to shipping production features faster with LLM-powered development tools, context management, and enterprise-grade practices."
more_link: "yes"
url: "/ai-assisted-development-claude-code-production-patterns-enterprise-guide/"
---

AI-assisted development with tools like Claude Code fundamentally transforms software engineering workflows, enabling rapid feature delivery while maintaining code quality. This comprehensive guide covers 50 production-tested patterns for maximizing LLM development productivity in enterprise environments.

<!--more-->

# [Foundation: Planning and Context](#foundation-planning)

## 1. Planning Before Prompting

```markdown
# Feature Specification Template (Write BEFORE opening Claude Code)

## Feature: User Authentication System
**Goal**: Implement JWT-based authentication with refresh tokens

**Context**:
- Framework: FastAPI (Python 3.11)
- Database: PostgreSQL 14
- Current auth: None (greenfield)
- Dependencies: python-jose, passlib, bcrypt

**Requirements**:
1. User registration endpoint
2. Login with email/password
3. JWT access tokens (15min expiry)
4. Refresh token rotation
5. Password hashing with bcrypt
6. Token blacklist for logout

**Database Schema**:
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    revoked BOOLEAN DEFAULT FALSE
);
```

**API Endpoints**:
- POST /auth/register
- POST /auth/login
- POST /auth/refresh
- POST /auth/logout

**Security Considerations**:
- Rate limiting: 5 requests/min per IP
- Password requirements: 12+ chars, mixed case, numbers
- HTTPS only in production
```

**Key Principle**: AI amplifies clarity or confusion. Clear specifications produce clean code. Vague requests produce technical debt.

## 2. Comprehensive Context Provision

```xml
<context>
  <project>
    <name>E-commerce Platform API</name>
    <framework>Django 4.2</framework>
    <database>PostgreSQL 15</database>
    <deployment>Kubernetes on AWS EKS</deployment>
  </project>

  <file_structure>
    <![CDATA[
    api/
    ├── authentication/
    │   ├── models.py
    │   ├── serializers.py
    │   └── views.py
    ├── products/
    │   ├── models.py
    │   ├── serializers.py
    │   └── views.py
    └── settings/
        ├── base.py
        ├── production.py
        └── development.py
    ]]>
  </file_structure>

  <current_models>
    <model name="Product">
      <field name="id" type="UUIDField" primary_key="true"/>
      <field name="name" type="CharField" max_length="200"/>
      <field name="price" type="DecimalField" max_digits="10" decimal_places="2"/>
      <field name="inventory" type="IntegerField"/>
    </model>
  </current_models>

  <api_contracts>
    <endpoint method="GET" path="/api/v1/products/">
      <response status="200">
        {
          "results": [
            {"id": "uuid", "name": "string", "price": "decimal", "inventory": "integer"}
          ],
          "count": "integer",
          "next": "url|null",
          "previous": "url|null"
        }
      </response>
    </endpoint>
  </api_contracts>

  <screenshots>
    <!-- Attach actual screenshots for UI work -->
    <file path="./docs/screenshots/product-list-page.png"/>
    <file path="./docs/screenshots/checkout-flow.png"/>
  </screenshots>
</context>
```

## 3. XML-Structured Prompts

```xml
<task>
  <objective>Implement product search functionality with full-text search</objective>

  <requirements>
    <requirement priority="high">Search by product name and description</requirement>
    <requirement priority="high">Filter by price range</requirement>
    <requirement priority="medium">Filter by category</requirement>
    <requirement priority="low">Autocomplete suggestions</requirement>
  </requirements>

  <constraints>
    <constraint>Must use PostgreSQL full-text search (no Elasticsearch)</constraint>
    <constraint>Query performance must be under 100ms for 10k products</constraint>
    <constraint>Pagination required (50 items per page)</constraint>
  </constraints>

  <acceptance_criteria>
    <criterion>Search returns relevant results ranked by relevance</criterion>
    <criterion>Price filter accepts min/max parameters</criterion>
    <criterion>API endpoint follows existing naming conventions</criterion>
    <criterion>Comprehensive test coverage (>90%)</criterion>
  </acceptance_criteria>

  <implementation_notes>
    <note>Use Django's SearchVector and SearchQuery</note>
    <note>Add GIN index on search_vector column</note>
    <note>Implement debounce on autocomplete (300ms)</note>
  </implementation_notes>
</task>
```

**Observation**: XML formatting provides 3x better results than plaintext due to LLM native structured data parsing.

# [Agent Architecture Patterns](#agent-architecture)

## 4. Specialized Agent Hierarchy

```bash
# Single-purpose agent examples

# Frontend Agent (React/TypeScript)
claude-code-frontend/
├── .claud.md
│   Rules:
│   - Only modify files in src/components/ and src/pages/
│   - Use TypeScript strict mode
│   - Follow React hooks best practices
│   - All components must have PropTypes or TypeScript interfaces
│   - Use CSS modules for styling

# Backend Agent (Python/FastAPI)
claude-code-backend/
├── CLAUDE.md
│   Rules:
│   - Only modify files in api/ directory
│   - All endpoints must have Pydantic models
│   - Include OpenAPI documentation
│   - Async/await for all I/O operations
│   - Comprehensive error handling with custom exceptions

# Database Agent (PostgreSQL migrations)
claude-code-database/
├── CLAUDE.md
│   Rules:
│   - Only create migration files
│   - Never modify existing migrations
│   - Include both up and down migrations
│   - Add indexes for foreign keys
│   - Document migration purpose in comments

# Infrastructure Agent (Terraform/Kubernetes)
claude-code-infrastructure/
├── CLAUDE.md
│   Rules:
│   - Only modify infrastructure/ directory
│   - Terraform: use variables, no hardcoded values
│   - Kubernetes: include resource limits
│   - Tag all cloud resources with environment/project
│   - Include cost estimation comments
```

**Principle**: Build many specialized agents that do ONE thing perfectly, not one mega-agent attempting everything.

## 5. MCP (Model Context Protocol) Integration

```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "args": ["/path/to/project"]
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "POSTGRES_CONNECTION_STRING": "${DATABASE_URL}"
      }
    }
  }
}
```

**Critical**: MCPs save 80% of context and prevent memory loss. Non-negotiable for serious production work.

# [Session Management](#session-management)

## 6. Token Budget Awareness

```python
# Monitor token usage and reset at 50% capacity

Current Conversation: 45,000 / 100,000 tokens (45%)
Action: Continue current session

Current Conversation: 52,000 / 100,000 tokens (52%)
Action: Start fresh session with context handoff

# Context handoff template
"""
Previous session summary:

Completed:
- Implemented user authentication endpoints
- Added JWT token generation
- Created user registration flow

In Progress:
- Email verification system (70% complete)
  - Email service configured
  - Verification token generation working
  - Need to complete: email template, verification endpoint

Current State:
- All tests passing
- Database migrations applied
- API documented in OpenAPI spec

Next Steps:
1. Complete email verification endpoint
2. Add rate limiting to auth endpoints
3. Implement password reset flow
"""
```

**Observation**: At 50% token limit, start fresh. Compaction progressively degrades output quality.

## 7. Custom Commands for Repetition

```bash
# .claude-commands.json
{
  "commands": {
    "/review": {
      "description": "Comprehensive code review",
      "prompt": "Review all modified files for:\n1. Security vulnerabilities\n2. Performance issues\n3. Code style violations\n4. Missing tests\n5. Documentation gaps\n\nProvide specific line numbers and suggested fixes."
    },
    "/test": {
      "description": "Generate comprehensive tests",
      "prompt": "Generate pytest tests for the current module:\n1. Happy path tests\n2. Edge cases\n3. Error conditions\n4. Integration tests\n5. Aim for >90% coverage"
    },
    "/optimize": {
      "description": "Performance optimization analysis",
      "prompt": "Analyze code for performance optimizations:\n1. Database query efficiency\n2. Caching opportunities\n3. Async/await usage\n4. Memory allocation patterns\n5. Algorithm complexity"
    },
    "/secure": {
      "description": "Security audit",
      "prompt": "Perform security audit:\n1. SQL injection vulnerabilities\n2. XSS attack vectors\n3. CSRF protection\n4. Authentication/authorization issues\n5. Secrets management\n6. Input validation"
    },
    "/document": {
      "description": "Generate documentation",
      "prompt": "Generate comprehensive documentation:\n1. Docstrings for all functions/classes\n2. README with usage examples\n3. API endpoint documentation\n4. Architecture decision records\n5. Deployment instructions"
    }
  }
}
```

**Impact**: Custom commands save 2+ hours daily minimum through consistent, repeatable instructions.

## 8. Claude Code Hooks

```bash
# .claude/hooks/pre-commit
#!/bin/bash
# Run before each commit

echo "Running pre-commit hooks..."

# 1. Format code
black .
isort .

# 2. Lint
pylint api/
mypy api/ --strict

# 3. Security scan
bandit -r api/

# 4. Run tests
pytest tests/ --cov=api --cov-report=term-missing

# 5. Check for secrets
detect-secrets scan --baseline .secrets.baseline

if [ $? -ne 0 ]; then
    echo "Pre-commit checks failed!"
    exit 1
fi

echo "All checks passed!"
```

```bash
# .claude/hooks/post-feature
#!/bin/bash
# Run after completing a feature

echo "Running post-feature validation..."

# 1. Update PROJECT_CONTEXT.md
echo "## Feature: $1" >> PROJECT_CONTEXT.md
echo "Completed: $(date)" >> PROJECT_CONTEXT.md
echo "" >> PROJECT_CONTEXT.md

# 2. Generate changelog entry
git log --oneline -1 >> CHANGELOG.md

# 3. Run full test suite
pytest tests/ --verbose

# 4. Update API documentation
python manage.py spectacular --file schema.yml

# 5. Check for breaking changes
python scripts/check_breaking_changes.py

echo "Post-feature validation complete!"
```

**Principle**: Claude Code hooks are criminally underused. Set once, benefit forever.

# [Development Workflow Patterns](#workflow-patterns)

## 9. Single-Feature Isolation

```markdown
# ❌ Bad: Multiple features in one chat
"Add user authentication, implement product search, and fix the checkout bug"

# ✅ Good: One feature per chat
Session 1: "Implement JWT-based user authentication"
Session 2: "Add full-text product search with PostgreSQL"
Session 3: "Debug and fix checkout cart calculation error"
```

**Rule**: One feature per chat, always. Mixing features is coding drunk.

## 10. Post-Completion Review Protocol

```markdown
After every feature completion, always ask:

"Review your work and list what might be broken. Consider:

1. **Edge Cases**: What inputs haven't been tested?
2. **Error Handling**: What can throw exceptions?
3. **Race Conditions**: Any async/concurrent issues?
4. **Database Integrity**: Foreign key constraints, indexes?
5. **Security**: Authentication, authorization, input validation?
6. **Performance**: N+1 queries, inefficient algorithms?
7. **Breaking Changes**: API compatibility, migration path?
8. **Dependencies**: Version conflicts, missing packages?
9. **Configuration**: Environment-specific settings?
10. **Documentation**: Is everything documented?"

Then fix issues BEFORE moving to next feature.
```

## 11. Visual Context Superiority

```bash
# Screenshots provide 10x more context than text

# Text description (inefficient):
"The product list page shows products in a grid layout with 4 columns.
Each product card has an image, title, price, and add-to-cart button.
The cards have a subtle shadow and rounded corners. The grid is responsive
and collapses to 2 columns on tablets and 1 column on mobile."

# Better: Drag screenshot directly into terminal
# [screenshot-product-list.png]

# Then simply prompt:
"Implement this exact layout using React and Tailwind CSS"
```

## 12. Test Loop Persistence

```bash
# Keep running tests until they actually pass

Iteration 1:
> Run tests
FAILED: test_user_registration - AssertionError: 400 != 201

> Fix validation error
> Run tests
FAILED: test_user_registration - KeyError: 'email'

> Fix missing field
> Run tests
FAILED: test_user_registration - IntegrityError: duplicate key

> Add unique constraint check
> Run tests
PASSED: test_user_registration ✓

# "Should work" means it doesn't work
# Loop until green
```

# [Context and Memory Management](#context-memory)

## 13. Concise Rules Files

```markdown
# CLAUDE.md (Keep under 100 lines)

## Tech Stack
- Backend: FastAPI (Python 3.11)
- Database: PostgreSQL 15
- Frontend: React 18 + TypeScript
- Deployment: Docker + Kubernetes

## Code Standards
- Type hints for all Python functions
- Async/await for I/O operations
- Pydantic models for all API contracts
- Jest + React Testing Library for frontend tests
- 90%+ test coverage required

## Never Do
- Modify database migrations
- Commit secrets or API keys
- Use `any` type in TypeScript
- Bypass authentication checks
- Use `SELECT *` in queries

## Always Do
- Add docstrings to public functions
- Include error handling
- Log important operations
- Update PROJECT_CONTEXT.md after changes
- Run tests before committing

## Security
- Validate all user inputs
- Use parameterized queries (no string interpolation)
- Implement rate limiting on public endpoints
- Hash passwords with bcrypt (cost factor 12)
- Use HTTPS in production
```

**Observation**: Concise beats comprehensive. Focused rules are followed; verbose rules are ignored.

## 14. Test-Driven Development with AI

```python
# Write tests BEFORE implementation

# 1. Define test cases
@pytest.mark.asyncio
async def test_user_registration_success():
    """Test successful user registration"""
    user_data = {
        "email": "test@example.com",
        "password": "SecurePass123!",
        "name": "Test User"
    }

    response = await client.post("/auth/register", json=user_data)

    assert response.status_code == 201
    assert "id" in response.json()
    assert response.json()["email"] == user_data["email"]
    assert "password" not in response.json()  # Never return password

@pytest.mark.asyncio
async def test_user_registration_duplicate_email():
    """Test registration with duplicate email fails"""
    # Setup: Create existing user
    await create_user(email="existing@example.com")

    # Attempt to register with same email
    response = await client.post("/auth/register", json={
        "email": "existing@example.com",
        "password": "SecurePass123!"
    })

    assert response.status_code == 400
    assert "already exists" in response.json()["detail"].lower()

# 2. Then prompt Claude Code:
"""
Implement the user registration endpoint to make these tests pass.

Requirements from tests:
- POST /auth/register endpoint
- Accept email, password, name
- Return 201 with user object (no password)
- Prevent duplicate email registration
- Use async/await
"""

# 3. TDD with AI prevents debugging nightmares
```

## 15. PROJECT_CONTEXT.md Maintenance

```markdown
# PROJECT_CONTEXT.md

## Project Overview
E-commerce platform API for selling digital and physical products.

## Current Architecture
```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   React     │────▶│   FastAPI    │────▶│  PostgreSQL  │
│   Frontend  │     │   Backend    │     │   Database   │
└─────────────┘     └──────────────┘     └──────────────┘
       │                    │                     │
       │                    ▼                     │
       │            ┌──────────────┐              │
       └───────────▶│    Redis     │◀─────────────┘
                    │    Cache     │
                    └──────────────┘
```

## Completed Features
- ✅ User authentication (JWT + refresh tokens)
- ✅ Product CRUD operations
- ✅ Shopping cart management
- ✅ Order processing
- ✅ Payment integration (Stripe)
- ✅ Email notifications
- ✅ Full-text product search

## In Progress
- 🔨 Inventory management system (60% complete)
  - Stock tracking implemented
  - Low stock alerts working
  - TODO: Automated reordering
  - TODO: Supplier integration

## Next Features
1. User reviews and ratings
2. Recommendation engine
3. Admin dashboard
4. Analytics integration

## Recent Decisions
- **2025-01-15**: Switched from SQLAlchemy to pure asyncpg for 40% query performance improvement
- **2025-01-10**: Adopted Pydantic V2 for 2x faster validation
- **2025-01-05**: Implemented Redis caching for product listings (95% cache hit rate)

## Known Issues
- Product images occasionally fail to upload on S3 (rate limit issue)
- Search relevance needs tuning for products with similar names
- Checkout flow needs better error messages

## Dependencies
- Python 3.11+
- PostgreSQL 15+
- Redis 7+
- Node.js 18+ (frontend)

## Environment Variables
```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/ecommerce
REDIS_URL=redis://localhost:6379/0
SECRET_KEY=<generate-strong-key>
STRIPE_API_KEY=<stripe-secret>
AWS_ACCESS_KEY=<aws-key>
AWS_SECRET_KEY=<aws-secret>
S3_BUCKET=ecommerce-uploads
```

**Last Updated**: 2025-01-20 by Claude Code
```

**Critical**: Update PROJECT_CONTEXT.md after each session for continuity across conversations.

## 16. Surgical Fix Requests

```markdown
# ❌ Bad: Vague fix request
"The checkout is broken, fix it"

# ✅ Good: Specific, isolated fix
"Fix the tax calculation in checkout/utils.py:calculate_tax() function
WITHOUT changing:
- The discount calculation logic
- The shipping fee calculation
- The database schema
- The API contract

Only modify the tax calculation formula to correctly handle multi-state
sales tax rates from the tax_rates table."
```

**Principle**: "Fix this without changing anything else" prevents cascade failures.

# [Agent Specialization](#agent-specialization)

## 17. Domain-Specific Agents

```bash
# Frontend Agent
Agent: claude-frontend
Context: React components, TypeScript, CSS
Rules:
- Use functional components with hooks
- TypeScript strict mode
- CSS modules for styling
- PropTypes or interfaces required
- Accessibility (a11y) compliance

# Backend Agent
Agent: claude-backend
Context: FastAPI, database models, business logic
Rules:
- Async/await for I/O
- Pydantic validation
- Comprehensive error handling
- OpenAPI documentation
- Database transactions for multi-step operations

# Database Agent
Agent: claude-database
Context: PostgreSQL schemas, migrations, queries
Rules:
- Alembic migrations only
- Never modify existing migrations
- Include up and down migrations
- Add indexes for performance
- Foreign key constraints required
```

## 18. Explain-While-Working Pattern

```markdown
After making changes, always ask:

"Explain what you changed and why. Include:

1. **Files Modified**: List with line numbers
2. **Changes Made**: What specifically changed
3. **Reasoning**: Why this approach was chosen
4. **Tradeoffs**: Alternative approaches considered
5. **Side Effects**: What else might be affected
6. **Testing**: How to verify changes work
7. **Rollback**: How to undo if needed"

Example response:
"""
Changes Made:

1. api/auth/views.py (lines 45-67)
   - Added rate limiting decorator to login endpoint
   - Limit: 5 attempts per 15 minutes per IP
   - Uses Redis for distributed rate limit tracking

2. requirements.txt
   - Added slowapi==0.1.9 for rate limiting

Reasoning:
- Prevent brute force attacks on login endpoint
- Distributed rate limiting works across multiple API instances
- Redis provides fast lookup and automatic expiration

Tradeoffs Considered:
- In-memory rate limiting: Doesn't work with multiple instances
- Database rate limiting: Too slow for high-traffic endpoints
- Chose Redis: Fast, distributed, automatic cleanup

Side Effects:
- Requires Redis connection (already used for caching)
- Failed login attempts now return 429 after limit exceeded
- May need to whitelist internal IPs for monitoring tools

Testing:
```bash
# Test rate limiting
for i in {1..6}; do
  curl -X POST http://localhost:8000/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@example.com","password":"wrong"}'
done
# 6th request should return 429 Too Many Requests
```

Rollback:
- Remove slowapi from requirements.txt
- Remove @limiter.limit decorator from login view
- Restart application
"""
```

## 19. Checkpoint-Based Development

```markdown
# Set explicit stopping points to prevent runaway changes

Prompt:
"Implement user authentication system.

**Checkpoint 1**: After creating database models, STOP and show me the schema
**Checkpoint 2**: After implementing registration endpoint, STOP for review
**Checkpoint 3**: After adding login endpoint, STOP for testing
**Checkpoint 4**: After implementing JWT tokens, STOP for security review

At each checkpoint:
1. Show what was completed
2. Show what's next
3. Wait for explicit approval before continuing"
```

## 20. Commit-After-Feature Protocol

```bash
# Git commit after EVERY working feature

# ✅ Good: Granular commits
git add api/auth/
git commit -m "feat: Add user registration endpoint

- Implement POST /auth/register
- Add email/password validation
- Hash passwords with bcrypt
- Return JWT token on success
- Add comprehensive tests (95% coverage)

Tests: pytest tests/test_auth.py::test_registration -v
Closes: #123"

git add api/auth/login.py
git commit -m "feat: Add user login endpoint

- Implement POST /auth/login
- Validate credentials
- Generate JWT access + refresh tokens
- Add rate limiting (5 req/15min)
- Add integration tests

Tests: pytest tests/test_auth.py::test_login -v
Relates: #124"

# ❌ Bad: Mega commits
git add .
git commit -m "Add authentication system"
# (100 files changed, 5000 insertions, 2000 deletions)
```

**Rule**: Git commit after EVERY working feature. Reverting beats fixing.

# [Debugging and Problem-Solving](#debugging)

## 21. Pre-Debug Planning

```markdown
# Generate debug plan before attempting fixes

Prompt:
"Create a debugging plan for this issue: Users report checkout failing
when cart has more than 5 items.

Include:
1. **Hypothesis**: Likely root causes
2. **Reproduction**: Steps to reproduce locally
3. **Investigation**: What to check and in what order
4. **Logging**: What debug output to add
5. **Testing**: How to verify fix works
6. **Prevention**: How to prevent recurrence"

Expected output:
"""
Debug Plan: Checkout Failure >5 Items

Hypothesis:
1. Database query limit/pagination issue
2. Session/cookie size limit exceeded
3. Cart calculation overflow or timeout
4. Validation rule incorrectly applied

Reproduction Steps:
```python
# Create test case
def test_checkout_large_cart():
    cart = create_cart_with_items(count=10)
    response = client.post("/checkout", json=cart.dict())
    assert response.status_code == 200
```

Investigation Order:
1. Check application logs for errors around checkout
2. Examine database queries for cart items >5
3. Review session storage size limits
4. Check cart validation rules
5. Monitor memory/CPU during checkout

Debug Logging:
```python
# Add to checkout view
logger.info(f"Processing checkout: {cart.item_count} items")
logger.debug(f"Cart data: {cart.dict()}")
logger.debug(f"Session size: {len(json.dumps(session.dict()))} bytes")
```

Verification:
- Test with 1, 5, 10, 50, 100 items
- Check all payment methods
- Verify across different user types
- Load test with concurrent checkouts

Prevention:
- Add integration test for large carts
- Implement cart item limit (e.g., 100 items max)
- Add monitoring alert for checkout failures >5%
- Document session size constraints
"""
```

## 22. Code Quality Emphasis

```markdown
# Request maintainable code explicitly

"Write code your future self can modify. Prioritize:

1. **Readability**: Clear variable names, simple logic
2. **Modularity**: Small functions, single responsibility
3. **Documentation**: Docstrings, inline comments for complex logic
4. **Extensibility**: Easy to add features without refactoring
5. **Testability**: Pure functions, dependency injection
6. **Error Messages**: Descriptive, actionable error messages

Example - readability:
```python
# ❌ Bad
def p(u, a):
    return (u.r == 'a' or u.r == 's') and a in u.p

# ✅ Good
def user_has_permission(user: User, action: str) -> bool:
    \"\"\"Check if user has permission to perform action.

    Args:
        user: User object with role and permissions
        action: Permission to check (e.g., 'create_product')

    Returns:
        True if user is admin/superuser OR has explicit permission
    \"\"\"
    is_privileged = user.role in ['admin', 'superuser']
    has_explicit_permission = action in user.permissions
    return is_privileged or has_explicit_permission
```
"""
```

## 23. Failure Documentation

```markdown
# DONT_DO.md - Learn from past mistakes

## Architecture Decisions

### ❌ Don't: Use synchronous database calls in FastAPI
**Date**: 2025-01-10
**Problem**: Blocked event loop, caused 5s response times under load
**Solution**: Migrated to async SQLAlchemy + asyncpg
**Lesson**: Always use async/await for I/O in async frameworks

### ❌ Don't: Store sessions in database without indexing
**Date**: 2025-01-08
**Problem**: Session lookup took 2s with 10k active sessions
**Solution**: Added index on session_token column
**Lesson**: Index all columns used in WHERE clauses

### ❌ Don't: Use CASCADE DELETE without careful consideration
**Date**: 2025-01-05
**Problem**: Deleting user accidentally deleted all their order history
**Solution**: Changed to SET NULL for order.user_id
**Lesson**: Preserve audit trails; soft delete users instead

## Code Patterns

### ❌ Don't: Catch-all exception handlers
```python
# Bad
try:
    process_payment()
except:  # Catches KeyboardInterrupt, SystemExit, etc.
    log.error("Payment failed")
```

### ✅ Do: Specific exception handling
```python
# Good
try:
    process_payment()
except PaymentError as e:
    log.error(f"Payment failed: {e}")
    notify_admin(e)
except NetworkError as e:
    log.warning(f"Temporary network issue: {e}")
    queue_for_retry(payment)
```

## Deployment Issues

### ❌ Don't: Deploy without database migration dry-run
**Date**: 2025-01-03
**Problem**: Migration locked table for 5 minutes during peak traffic
**Solution**: Test migrations on production copy first
**Lesson**: Always estimate migration duration and lock impact
```

**Principle**: AI forgets but you shouldn't. Document failures to prevent repetition.

# [Advanced Patterns](#advanced-patterns)

## 24. Session Initialization Protocol

```markdown
Start EVERY session with standard context:

"Project Context:
- E-commerce API (FastAPI + PostgreSQL)
- Current feature: Inventory management system
- Last session: Implemented stock tracking
- See PROJECT_CONTEXT.md for details

Rules:
- See CLAUDE.md for coding standards
- See DONT_DO.md for past failures

What NOT to do:
- Don't modify existing migrations
- Don't bypass authentication
- Don't use synchronous database calls
- Don't commit secrets

Current task: Implement automated reordering when stock falls below threshold"
```

## 25. Task Orchestration Strategy

```markdown
# Give tasks one at a time, review each before proceeding

# ❌ Bad: Chain of tasks
"Implement user authentication, add product search, fix the checkout bug,
and optimize database queries"

# ✅ Good: Sequential with review
Task 1: "Implement user registration endpoint"
> Review output, verify tests pass
> Commit changes

Task 2: "Implement user login endpoint"
> Review output, verify tests pass
> Commit changes

Task 3: "Add JWT token refresh endpoint"
> Review output, verify tests pass
> Commit changes

# You orchestrate, AI executes
# Review EVERYTHING before trusting
```

## 26. Playwright MCP for UI Work

```bash
# Use Playwright MCP with Sonnet for comprehensive UI testing

npx playwright test --headed

# Playwright can:
# 1. Visually inspect the interface
# 2. Test interactions (clicks, forms, navigation)
# 3. Read browser console for JavaScript errors
# 4. Capture screenshots of failures
# 5. Generate test code from recordings

# Example test generation:
npx playwright codegen http://localhost:3000

# Better than screenshots alone:
# - Tests document expected behavior
# - Automated regression testing
# - Cross-browser compatibility checks
```

## 27. Long Task Context Preservation

```markdown
# For multi-hour tasks, maintain context without wiping conversation

Approach 1: Internal To-Do List
"Create an internal to-do list for this feature, then tackle one item at
a time. After completing each item, update the list and wait for my approval
before proceeding."

Example:
"""
Feature: Inventory Management System

To-Do List:
- [✓] Create database schema for inventory
- [✓] Implement stock tracking
- [⧗] Add low stock alerts (in progress)
  - [✓] Create alert model
  - [✓] Add background job for checking
  - [ ] Implement email notifications
  - [ ] Add webhook notifications
- [ ] Implement automated reordering
- [ ] Create admin UI for inventory management
- [ ] Add inventory audit logging

Current: Working on email notifications for low stock alerts
Next: Webhook notifications
"""

Approach 2: Checkpoint Saves
# Save conversation state at logical breakpoints
# Return to saved checkpoint instead of starting fresh
```

## 28. Sub-Agent Cost Optimization

```markdown
# Use cheaper models for non-critical sub-tasks

Main Agent (Sonnet 4):
- Feature implementation
- Code generation
- Architecture decisions
- Complex debugging

Sub-Agents (Haiku or GPT-3.5):
- Web searches
- API documentation lookups
- Formatting code
- Generating boilerplate
- Simple data transformations

# Cost comparison:
# Sonnet: $3/M input tokens, $15/M output tokens
# Haiku: $0.25/M input tokens, $1.25/M output tokens
# 12x cost reduction for appropriate tasks

Example routing:
"Use the web-search sub-agent to find the latest FastAPI documentation
for background tasks, then summarize the findings."
```

## 29. Explicit Sub-Agent Routing

```markdown
# Direct sub-agent usage explicitly

# ❌ Implicit (unreliable):
"Look up the Stripe API documentation and implement payment processing"
# Claude might route incorrectly or not use sub-agents

# ✅ Explicit (reliable):
"Use the documentation-search agent to find Stripe payment intent API docs.
Once you have the information, implement the payment processing endpoint."

# Sub-agent usage guidelines:
# 1. Information gathering: Use sub-agents
# 2. Code changes: Use main agent
# 3. Verification: Use sub-agents for checks, main agent for fixes
```

## 30. Sub-Agent Information Gathering

```markdown
# Use sub-agents ONLY for information, not execution

# ✅ Good: Information gathering
"Use the GitHub sub-agent to:
1. List open issues labeled 'bug'
2. Get the last 10 commits to main branch
3. Check CI/CD status

Then summarize findings and propose a fix for the highest priority bug."

# ❌ Bad: Direct execution via sub-agent
"Use the GitHub sub-agent to create a pull request with these changes"
# You lose visibility and control

# Principle: Sub-agents gather, main agent executes
# You approve all changes
```

## 31. Directory-Specific Rules

```markdown
# api/CLAUDE.md (Backend rules)
## API Development Rules
- All endpoints async
- Pydantic models required
- OpenAPI docs mandatory
- Authentication on all non-public endpoints
- Rate limiting on public endpoints
- Comprehensive error handling

# frontend/CLAUDE.md (Frontend rules)
## Frontend Development Rules
- TypeScript strict mode
- React functional components only
- PropTypes or TypeScript interfaces required
- Accessibility (WCAG 2.1 AA) compliance
- Mobile-first responsive design
- Performance budget: <2s initial load

# database/CLAUDE.md (Database rules)
## Database Rules
- Alembic migrations only
- Never modify existing migrations
- Include up AND down migrations
- Index all foreign keys
- Document migration purpose
- Test migrations on copy of production data
```

## 32. Pre-Prompt LLM Clarification

```markdown
# Use another LLM to clarify prompts before sending to Claude

Your prompt (potentially vague):
"Add caching to the product API"

Run through clarification LLM:
"""
Context: E-commerce API with FastAPI and PostgreSQL

Vague prompt: "Add caching to the product API"

Generate clarifying questions and suggest improved prompt.
"""

Clarification LLM output:
"""
Questions needing clarification:
1. Which specific endpoints need caching?
2. What should be the cache duration?
3. What cache backend (Redis, Memcached, in-memory)?
4. What's the cache invalidation strategy?
5. Should this be read-through or write-through caching?

Improved prompt:
"Implement Redis caching for the GET /products/ list endpoint:
- Cache TTL: 5 minutes
- Cache key: Include query parameters (page, category, search)
- Invalidation: Automatic on product creation/update/deletion
- Use Redis cache backend (already configured at $REDIS_URL)
- Add cache hit/miss metrics
- Implement cache warming for top 100 products
- Include tests for cache behavior"
"""
```

## 33. Routine Task Slash Commands

```bash
# Build reusable slash commands for common operations

# /debug command
{
  "name": "debug",
  "description": "Comprehensive debugging workflow",
  "steps": [
    "Analyze the error and propose 3 possible root causes",
    "For each hypothesis, list verification steps",
    "Add detailed logging at key points",
    "Create minimal reproduction test case",
    "Implement fix with explanation",
    "Verify fix doesn't introduce regressions",
    "Document root cause and solution in DEBUGGING.md"
  ]
}

# /cleanup command
{
  "name": "cleanup",
  "description": "Code cleanup and refactoring",
  "steps": [
    "Identify code smells (long functions, duplications, complex conditionals)",
    "Propose refactoring approach",
    "Extract reusable functions/classes",
    "Improve variable/function naming",
    "Add missing docstrings",
    "Remove dead code",
    "Update tests to match refactored code",
    "Verify all tests still pass"
  ]
}

# /security command
{
  "name": "security",
  "description": "Security audit and hardening",
  "checks": [
    "SQL injection vulnerabilities (use parameterized queries)",
    "XSS attack vectors (escape output, CSP headers)",
    "CSRF protection (tokens on state-changing operations)",
    "Authentication bypass opportunities",
    "Authorization issues (check permissions)",
    "Secrets in code or logs",
    "Insecure dependencies (known CVEs)",
    "Missing rate limiting",
    "Insufficient input validation",
    "Insecure defaults"
  ]
}
```

## 34. Refactoring Progress Tracking

```json
// refactoring-log.json
{
  "feature": "Convert synchronous database calls to async",
  "started": "2025-01-20T09:00:00Z",
  "target_files": 47,
  "completed_files": 32,
  "progress": [
    {
      "file": "api/products/views.py",
      "status": "completed",
      "timestamp": "2025-01-20T09:15:00Z",
      "changes": [
        "Converted get_products() to async",
        "Replaced psycopg2 with asyncpg",
        "Updated tests to use pytest-asyncio"
      ],
      "tests_passing": true
    },
    {
      "file": "api/orders/views.py",
      "status": "in_progress",
      "timestamp": "2025-01-20T10:30:00Z",
      "changes": [
        "Converted create_order() to async",
        "TODO: Update payment processing integration"
      ],
      "tests_passing": false,
      "blockers": ["Payment gateway SDK doesn't support async"]
    }
  ],
  "next_files": [
    "api/users/views.py",
    "api/cart/views.py"
  ]
}
```

```markdown
After each refactoring step:
"Update refactoring-log.json with:
- File modified
- Changes made
- Test status
- Any blockers
- Next file to tackle"
```

## 35. Self-Review Protocol

```markdown
After completing any task:

"Re-check your own work and prove it was done correctly:

1. **Syntax**: Run linter/formatter, fix all issues
2. **Types**: Run type checker, resolve all errors
3. **Tests**: Run test suite, all must pass
4. **Security**: No new vulnerabilities introduced
5. **Performance**: No obvious performance regressions
6. **Documentation**: Code is documented
7. **Edge Cases**: Handled appropriately
8. **Error Handling**: Comprehensive exception handling
9. **Code Review**: Would this pass peer review?
10. **Verification**: Provide evidence (test output, lint results)"

Example verification:
```bash
# Linting
$ black api/ --check
All done! ✨ 🍰 ✨
15 files would be left unchanged.

# Type checking
$ mypy api/ --strict
Success: no issues found in 15 source files

# Tests
$ pytest tests/ -v --cov=api
=================== test session starts ===================
tests/test_auth.py::test_registration PASSED        [ 10%]
tests/test_auth.py::test_login PASSED                [ 20%]
...
=================== 50 passed in 12.34s ===================
Coverage: 94%

# Security scan
$ bandit -r api/
No issues identified.
```
"""
```

## 36. Infinite Loop Detection and Recovery

```markdown
If Claude gets stuck in loops:

Detection:
- Same error repeated 3+ times
- No progress in 5+ attempts
- Circular reasoning

Recovery Protocol:
1. "Stop. Provide detailed debugging output for the current error:
   - Full error message and stack trace
   - Relevant code context
   - Values of key variables at failure point
   - What you've tried and why it failed"

2. Analyze debugging output, identify root cause

3. If still stuck after debugging analysis:
   "Start fresh session with context handoff"

4. In new session:
   "Previous session got stuck on: [describe issue]
    Approaches that DIDN'T work: [list failed attempts]
    Try a completely different approach using [alternative strategy]"
```

## 37. Essential MCP Selection

```json
// Minimal viable MCP configuration
{
  "mcpServers": {
    // Critical MCPs
    "sequential-thinking": {
      // Complex reasoning and planning
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "memory": {
      // Persistent context across sessions
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "github": {
      // Version control integration
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    },

    // Tech stack specific (choose based on your stack)
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"]
    }
  }
}

// Avoid MCP bloat:
// - Only add MCPs you use weekly
// - Remove unused MCPs (they consume context)
// - Tech-stack specific MCPs only
```

## 38. Automated Pre/Post Hooks

```bash
# .claude/hooks/pre-run
#!/bin/bash
# Runs before Claude executes any code changes

echo "=== Pre-run validation ==="

# 1. Check git status (no uncommitted changes from previous session)
if [[ -n $(git status -s) ]]; then
    echo "⚠️  Uncommitted changes detected"
    git status -s
fi

# 2. Check dependency versions
echo "Checking dependencies..."
pip list --outdated

# 3. Verify environment variables
required_vars=("DATABASE_URL" "REDIS_URL" "SECRET_KEY")
for var in "${required_vars[@]}"; do
    if [[ -z "${!var}" ]]; then
        echo "❌ Missing required env var: $var"
        exit 1
    fi
done

# 4. Run quick smoke tests
echo "Running smoke tests..."
pytest tests/smoke/ -q

echo "✅ Pre-run validation passed"
```

```bash
# .claude/hooks/post-run
#!/bin/bash
# Runs after Claude completes a task

echo "=== Post-run validation ==="

# 1. Run linters
black api/ --check
isort api/ --check-only
pylint api/

# 2. Run type checking
mypy api/ --strict

# 3. Run test suite
pytest tests/ --cov=api --cov-fail-under=90

# 4. Security scan
bandit -r api/
safety check

# 5. Check for secrets
detect-secrets scan --baseline .secrets.baseline

# 6. Update documentation
python scripts/generate_api_docs.py

# 7. Update PROJECT_CONTEXT.md timestamp
echo "Last modified: $(date)" >> PROJECT_CONTEXT.md

echo "✅ Post-run validation complete"
```

## 39. Visual Debugging

```markdown
# Screenshots explain problems faster than text

# Instead of:
"The button is misaligned, the spacing is wrong, and the color doesn't
match the design"

# Use:
1. Take screenshot of actual UI
2. Take screenshot of expected design
3. Drag both into Claude Code
4. Prompt: "Make the actual UI match the design mockup"

# For bugs:
1. Screenshot of error message
2. Screenshot of relevant code
3. Screenshot of network tab (if API issue)
4. Screenshot of console (if JavaScript issue)

# Visual context is 10x clearer than text descriptions
```

## 40. Model Selection Strategy

```markdown
# Opus 4.1: Complex reasoning and planning
- Architecture decisions
- Algorithm design
- Debugging complex issues
- Security analysis
- Performance optimization strategy

# Sonnet 4: General development
- Feature implementation
- Code refactoring
- Test writing
- Documentation
- Code reviews

# Haiku: Simple, repetitive tasks
- Code formatting
- Boilerplate generation
- Simple transformations
- Documentation lookups
- Routine updates

Cost optimization:
- Plan with Opus 4.1 (expensive but thorough)
- Implement with Sonnet 4 (balanced cost/quality)
- Execute simple tasks with Haiku (cheapest)
```

## 41. Planning/Execution Separation

```markdown
# Step 1: Plan with Opus 4.1
"Design the architecture for a real-time notification system.

Requirements:
- 100k concurrent WebSocket connections
- <100ms delivery latency
- Guaranteed delivery
- Multi-region support

Provide:
1. System architecture diagram
2. Technology choices with justification
3. Scalability strategy
4. Failure modes and mitigation
5. Implementation roadmap"

# Step 2: Implement with Sonnet 4
"Using this architecture plan [attach Opus output], implement Phase 1:
WebSocket connection handler with Redis pub/sub backend.

Follow the architecture exactly as specified."

# Separation benefits:
# - Better architecture (Opus reasoning)
# - Faster implementation (Sonnet speed)
# - Lower cost (Opus for planning only)
```

## 42. Version Control with ccundorepo

```bash
# Install Claude Code undo repository
git clone https://github.com/ccundorepo/ccundorepo
cd ccundorepo
pip install -e .

# Usage
ccundo init  # Initialize undo tracking

# Claude makes changes
# Changes are automatically tracked

ccundo list  # Show change history
ccundo diff <id>  # Show specific changes
ccundo revert <id>  # Revert to previous state

# Benefits:
# - Granular undo (not just git commits)
# - Track intermediate states
# - Safe experimentation
# - Easy rollback of AI changes
```

## 43. Automated Security Scanning

```bash
# .claude/hooks/security-scan
#!/bin/bash
# Runs after every code change

echo "=== Security Scan ==="

# 1. Static analysis
bandit -r api/ -f json -o bandit-report.json

# 2. Dependency vulnerabilities
safety check --json > safety-report.json

# 3. Secret detection
detect-secrets scan --baseline .secrets.baseline

# 4. Code quality (security-focused rules)
pylint api/ --disable=all --enable=security

# 5. Third-party security review (if configured)
# coderabbit scan ./

# 6. Parse results
python .claude/scripts/parse_security_results.py

if [ $? -ne 0 ]; then
    echo "❌ Security issues detected!"
    exit 1
fi

echo "✅ Security scan passed"
```

## 44. Explicit Security Requirements

```markdown
# AI doesn't write secure code by default - ask explicitly

For EVERY endpoint/feature:

"Implement [feature] with these security requirements:

**Input Validation**:
- Validate all user inputs with Pydantic models
- Reject invalid data with 400 Bad Request
- Sanitize inputs to prevent injection attacks

**SQL Injection Prevention**:
- Use parameterized queries (no string interpolation)
- Use ORM (SQLAlchemy) where possible
- Validate table/column names if dynamic

**XSS Prevention**:
- Escape all user-generated content in responses
- Set Content-Security-Policy headers
- Use Content-Type: application/json

**Authentication**:
- Require valid JWT token
- Verify token signature and expiration
- Check user has required permissions

**Rate Limiting**:
- 100 requests per minute per user
- 1000 requests per minute per IP
- Exponential backoff on repeated failures

**Database Security**:
- Enable Row Level Security (RLS) in PostgreSQL
- Use separate read-only users for queries
- Never expose raw database errors to clients

**Logging**:
- Log all authentication attempts
- Log all permission denials
- Never log passwords or tokens
- Sanitize logs to prevent log injection"
```

## 45. API Rate Limiting

```python
# Implement rate limiting with Upstash or similar

from upstash_ratelimit import Ratelimit, SlidingWindow
from upstash_redis import Redis

# Initialize Redis client
redis = Redis(url=os.getenv("REDIS_URL"))

# Create rate limiter
ratelimit = Ratelimit(
    redis=redis,
    limiter=SlidingWindow(requests=100, window=60),  # 100 req/min
    prefix="ratelimit"
)

@app.post("/api/endpoint")
async def endpoint(request: Request):
    # Get client identifier (user ID or IP)
    identifier = request.state.user.id if request.state.user else request.client.host

    # Check rate limit
    result = await ratelimit.limit(identifier)

    if not result.allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded. Retry after {result.reset}s",
            headers={"Retry-After": str(result.reset)}
        )

    # Process request
    return {"message": "Success"}
```

## 46. Deep Reasoning Tokens

```markdown
# "think harder" variations for complex problems

"think" - Standard reasoning (moderate token usage)
"think hard" - Deeper analysis (higher token usage)
"think harder" - Comprehensive analysis (high token usage)
"ultrathink" - Maximum reasoning depth (highest token usage)

Use cases:
- Complex debugging: "ultrathink about why this race condition occurs"
- Architecture decisions: "think harder about scaling this to 1M users"
- Security analysis: "think hard about attack vectors"
- Performance optimization: "ultrathink about reducing latency"

Warning:
- Increased token cost (2-5x)
- Not always better results (diminishing returns)
- Use only for genuinely complex problems
```

## 47. Rule Persistence Strategies

```markdown
# Rules disappear after conversation compaction - counter this:

Strategy 1: Repeat in Chat with #
"#CRITICAL_RULE: Never modify existing database migrations
#CRITICAL_RULE: Always use async/await for database calls
#CRITICAL_RULE: Validate all inputs with Pydantic models"

Strategy 2: Save in Multiple Files
- Project root: CLAUDE.md (global rules)
- Directory specific: api/CLAUDE.md (API rules)
- In chat: Reference rules explicitly

Strategy 3: Include in System Prompts
- Edit Claude Code settings
- Add rules to system prompt (never compacted)

Strategy 4: Create Hook Reminders
```bash
# .claude/hooks/pre-run
echo "Rules reminder:"
cat CLAUDE.md
cat DONT_DO.md
```

Strategy 5: Template Prompts
# Save rule-inclusive prompts as templates
# Load template instead of writing from scratch
```

## 48. Global Knowledge Base

```markdown
# .claude/GLOBAL_KNOWLEDGE.md
# Shared across all projects and agents

## Company Coding Standards
- Python: PEP 8, type hints required
- TypeScript: Strict mode, no `any`
- Testing: >90% coverage, TDD preferred
- Documentation: Docstrings + README
- Git: Conventional commits, signed commits required

## Security Standards
- Secrets: Never commit, use env vars
- Auth: JWT with refresh tokens
- Passwords: bcrypt with cost factor 12+
- APIs: Rate limiting mandatory
- Input: Validate everything, trust nothing

## Performance Standards
- API: <100ms p95 latency
- Database: Index foreign keys, avoid N+1
- Frontend: <2s initial load, <100ms interactions
- Cache: Redis for frequent reads
- CDN: All static assets

## Deployment Standards
- CI/CD: GitHub Actions, automated tests
- Staging: Required before production
- Rollback: Must be possible within 5 minutes
- Monitoring: Prometheus + Grafana
- Alerts: PagerDuty for critical issues

## Past Global Learnings
### 2025-01-15: Async/await in FastAPI
- Issue: Used sync database calls, blocking event loop
- Solution: Migrated to asyncpg
- Impact: 10x throughput improvement
- Rule: Always async for I/O in async frameworks

### 2025-01-10: Database Connection Pooling
- Issue: Opening new connection per request
- Solution: Implemented connection pool (min=10, max=50)
- Impact: 5x reduction in query latency
- Rule: Always use connection pooling in production

## Technology Decisions
- Primary language: Python 3.11+
- Web framework: FastAPI (async)
- Database: PostgreSQL 15+
- Cache: Redis 7+
- Frontend: React 18 + TypeScript
- Infrastructure: Kubernetes on AWS EKS
```

## 49. Daily Knowledge Base Updates

```bash
# .claude/scripts/update_knowledge.sh
#!/bin/bash
# Run daily to update global knowledge base

echo "=== Updating Global Knowledge Base ==="

# 1. Extract learnings from recent commits
git log --since="1 day ago" --pretty=format:"%h - %s" >> .claude/recent_changes.txt

# 2. Analyze error logs for common issues
python .claude/scripts/analyze_errors.py >> .claude/common_issues.txt

# 3. Update dependency versions
pip list --outdated > .claude/outdated_dependencies.txt

# 4. Prompt Claude to summarize learnings
cat << EOF
Review the following and update GLOBAL_KNOWLEDGE.md with any new learnings:

Recent changes:
$(cat .claude/recent_changes.txt)

Common issues:
$(cat .claude/common_issues.txt)

Outdated dependencies:
$(cat .claude/outdated_dependencies.txt)

Add to GLOBAL_KNOWLEDGE.md:
- New patterns discovered
- Common mistakes to avoid
- Performance optimizations
- Security improvements
- Dependency updates needed
EOF

# 5. Cleanup temporary files
rm .claude/recent_changes.txt .claude/common_issues.txt .claude/outdated_dependencies.txt

echo "✅ Knowledge base updated"
```

## 50. Continuous Learning Loop

```markdown
# Agent self-improvement over time

After every significant task:
"Update GLOBAL_KNOWLEDGE.md with:

1. **What Worked Well**:
   - Approaches that were efficient
   - Tools that helped
   - Patterns worth repeating

2. **What Didn't Work**:
   - Failed approaches
   - Time wasters
   - Anti-patterns encountered

3. **Lessons Learned**:
   - Better ways discovered
   - Edge cases to remember
   - Performance insights

4. **Future Improvements**:
   - How to do this faster next time
   - What to automate
   - What to document better

Example entry:
```
## Feature: Real-time Notifications (2025-01-20)

### What Worked Well
- Using WebSockets with Redis pub/sub for scalability
- Implementing heartbeat for connection health
- Separating notification logic into dedicated service

### What Didn't Work
- Initial attempt with Server-Sent Events (lacked bidirectional communication)
- Storing connection state in-memory (didn't scale across instances)

### Lessons Learned
- Redis pub/sub handles fan-out efficiently for real-time features
- WebSocket connection state must be in shared storage (Redis)
- Heartbeat interval of 30s balances responsiveness and overhead

### Future Improvements
- Template for real-time features (WebSocket + Redis + heartbeat)
- Add WebSocket testing utilities to test suite
- Document connection handling patterns
```

Over time, agents learn from past experiences and avoid repeating mistakes.
```

# [Conclusion](#conclusion)

AI-assisted development with Claude Code transforms software engineering productivity when combined with systematic patterns and disciplined workflows. The 50 practices detailed in this guide enable:

- **Faster Feature Delivery**: 3-10x speedup through clear specifications and specialized agents
- **Higher Code Quality**: Explicit security requirements, comprehensive testing, automated reviews
- **Better Maintainability**: Documentation-first approach, clean code emphasis, knowledge bases
- **Cost Optimization**: Appropriate model selection, efficient context management, sub-agent routing
- **Continuous Improvement**: Learning loops, failure documentation, evolving best practices

Key success factors:
1. Plan before prompting - clarity amplifies, confusion compounds
2. Provide comprehensive context - XML formatting, screenshots, schemas
3. Specialize agents - single-purpose beats multi-purpose
4. Manage context actively - MCPs, token budgets, session handoffs
5. Review everything - AI assists, you orchestrate and approve
6. Document learnings - build organizational memory

Start with core patterns (planning, context, single-feature isolation, test-driven development), add advanced techniques as workflows mature, and continuously evolve practices based on team experiences. AI development tools are multipliers - they amplify both good practices and bad ones. Invest in systematic approaches to maximize productivity gains while maintaining code quality and security standards.
