# Blog Post Creator — Full Guided Workflow

Create a complete, publication-ready blog post about "$ARGUMENTS" for support.tools. This workflow guides through 5 phases with approval gates at each step.

## Overview

Topic: **$ARGUMENTS**

You will execute 5 phases in order. Each phase ends by presenting results and asking the user for approval before proceeding. Do NOT skip ahead — wait for the user's response at each gate.

---

## Phase 1: DEDUPLICATION

Check whether this topic is already covered.

### Actions

1. Extract 2-4 core keywords from the topic
2. Use Glob to list all files in `blog/content/post/*.md`
3. Use Grep to search filenames and `title:` frontmatter lines for each keyword
4. For any matches, Read the first 30 lines to examine the frontmatter and introduction
5. Categorize matches as: **Direct match**, **Partial overlap**, or **Tangential**

### Gate 1 — Present to User

Report what was found:
- List any direct matches or partial overlaps with existing posts
- If no overlap: "No existing coverage found — safe to proceed"
- If overlap exists: suggest how to differentiate the new post

**Ask the user**: "Should I proceed with researching this topic, modify the angle, or cancel?"

**STOP and wait for the user's response before proceeding to Phase 2.**

---

## Phase 2: RESEARCH

Gather sources and technical details.

### Actions

1. Run 3-5 WebSearch queries with different angles:
   - Official documentation for the technology
   - Technical blog posts and engineering deep-dives
   - GitHub repositories and real-world usage
   - Known issues, CVEs, or production incidents
   - Benchmarks and comparison data

2. Use WebFetch on the top 3-5 most relevant results to extract:
   - Configuration examples and code snippets
   - Architecture details
   - Version-specific information
   - Best practices and anti-patterns
   - Troubleshooting scenarios

3. Compile a research brief with:
   - Topic summary (2-3 sentences)
   - Key technical details with sources
   - Recommended angle for the post
   - Source material list with URLs
   - Suggested sections
   - Available code examples
   - Open questions

### Gate 2 — Present to User

Present the research brief and ask:
- "Does this angle work for you?"
- "Any additional context, scenarios, or examples to include?"
- "Any sources I should dig deeper into?"

**STOP and wait for the user's response before proceeding to Phase 3.**

---

## Phase 3: OUTLINE

Generate structured outline with SEO frontmatter.

### Actions

1. Read `blog/_template.md` for frontmatter format
2. Read 2-3 existing posts (first 40 lines) to match style conventions
3. Reference `blog/scripts/blogutil/common.go` for filename/URL generation:
   - Lowercase title → replace spaces with hyphens → strip special chars → append `.md`
   - URL: `"/" + slug + "/"`

4. Generate the complete outline:

**Frontmatter:**
```yaml
---
title: "[SEO Title: Descriptive Subtitle]"
date: [future date in 2026, format 2026-MM-DDT09:00:00-05:00]
draft: false
tags: [7-12 specific tags]
categories: [1-3 broad categories]
author: "Matthew Mattox - mmattox@support.tools"
description: "[150-200 char SEO summary]"
more_link: "yes"
url: "/[slug]/"
---
```

**Content Structure:**
- Introduction (1-2 paragraphs) + `<!--more-->`
- Major sections (`##`) with subsections (`###`)
- Planned code blocks with language tags and descriptions
- Conclusion with bullet-point takeaways

**Target:** 800-1500 lines, 3000-6000 words

### Gate 3 — Present to User

Present the full outline and ask:
- "Does the scope and structure look right?"
- "Any sections to add, remove, or reorder?"
- "Any specific code examples or scenarios to include?"
- "Is the frontmatter (title, tags, URL) acceptable?"

**STOP and wait for the user's response before proceeding to Phase 4.**

---

## Phase 4: WRITE

Write the complete post section by section.

### Actions

**Writing style rules (match existing 300+ posts):**
- Enterprise-focused, highly technical tone
- No first-person pronouns
- `##` for major sections, `###` for subsections — never `#`
- `<!--more-->` after introduction
- Bold for key terms on first use
- Inline code for commands, paths, config keys
- Code blocks always have language tags
- YAML with inline comments, bash with `#` comments
- Realistic values — no placeholders
- Conclusion with bullet-point takeaways

**For each section:**
1. Write prose content (2-4 paragraphs per major section)
2. Write code blocks with proper language tags and comments
3. Validate code blocks after each section:
   - **YAML**: `python3 -c "import yaml; yaml.safe_load(open('file'))"`
   - **Bash**: `bash -n <(echo '...')`
   - **JSON**: `python3 -c "import json; json.loads('...')"`
   - **Go**: Write to temp file, run `gofmt`
4. Fix any validation errors before moving to the next section

Use the scratchpad directory for all temp files during validation.

### No Gate — Continue Directly to Phase 5

Phase 4 flows directly into Phase 5 (no approval gate needed between writing and file creation).

---

## Phase 5: FILE CREATION + REVIEW

Write the file and validate the complete post.

### Actions

1. **Assemble** the complete post: frontmatter + all sections
2. **Write** to `blog/content/post/[filename].md`
3. **Verify** by reading back the first 20 lines
4. **Count** lines, words, sections, code blocks
5. **Final validation** of all code blocks
6. **Duplicate check** — confirm no other post has the same URL slug

### Gate 5 — Present to User

Report the completed post:

```
## Blog Post Created

**File**: `blog/content/post/[filename].md`
**Title**: [title]
**URL**: [url]

### Stats
- Lines: [N]
- Words: ~[N]
- Sections: [N]
- Subsections: [N]
- Code blocks: [N] ([N] validated)

### Code Block Validation
1. [lang] — [description] — ✅/❌
2. ...

### Frontmatter
[Confirm all fields are correct]
```

**Ask the user**: "The post is ready. Would you like any revisions, or should I run a full `/blog-review` on it?"

---

## Important Rules

- **Never skip a gate** — always wait for user input before proceeding
- **Never use `#` headings** in the post content — Hugo generates the title
- **Always validate code** — every YAML, JSON, and bash block must pass syntax checks
- **Use realistic values** — no `xxx`, `TODO`, `your-value-here`, or `example.com` placeholders
- **No emoji** in post content
- **Match existing style** — read existing posts before writing to calibrate tone and depth
- **Target 800-1500 lines** — comprehensive but not padded
