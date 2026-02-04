# Blog Outline Generator

Generate a structured outline with SEO frontmatter for a blog post about "$ARGUMENTS" on support.tools.

## Instructions

You are creating an outline for the topic: **$ARGUMENTS**

### Step 1: Review Existing Conventions

Read the blog template to match the frontmatter format:
- Read `blog/_template.md` for the frontmatter structure
- Read `blog/config.toml` for site configuration (theme, author info)

Scan 2-3 recent existing posts in `blog/content/post/` to match the style:
- Use Glob to find posts, then Read the first 40 lines of 2-3 posts
- Note the frontmatter patterns: title format, tag count, category style, URL format, description length

### Step 2: Check for Existing Coverage

Use Grep to search `blog/content/post/` for the topic keywords in filenames and titles. Note any existing posts to avoid duplication and to find differentiation angles.

### Step 3: Generate Filename and URL

Follow the naming convention from `blog/scripts/blogutil/common.go`:
1. Take the title, convert to lowercase
2. Replace spaces with hyphens
3. Remove all characters except `a-z`, `0-9`, and `-`
4. Append `.md` for filename
5. URL: `"/" + slug + "/"`

### Step 4: Generate the Outline

Present the full outline in this format:

```
## Blog Post Outline

### Frontmatter
---
title: "[SEO Title: Descriptive Subtitle]"
date: [future date in 2026, format: 2026-MM-DDT09:00:00-05:00]
draft: false
tags: ["Tag1", "Tag2", ...]
categories: ["Category1", "Category2"]
author: "Matthew Mattox - mmattox@support.tools"
description: "[150-200 character SEO-friendly description]"
more_link: "yes"
url: "/[seo-friendly-slug]/"
---

### File
`blog/content/post/[filename].md`

### Structure

**Introduction** (1-2 paragraphs)
[Brief description of the opening — what problem this solves, why it matters]
<!--more-->

## Section 1: [Title]
[Description of content — 2-3 key points to cover]
- Code block: [language] — [what it demonstrates]

### Subsection 1.1: [Title]
[Description]

## Section 2: [Title]
[Description of content]
- Code block: [language] — [what it demonstrates]

[... continue for all planned sections ...]

## Conclusion
[Key takeaways to summarize — 3-5 bullet points]

### Estimated Size
- Sections: [N]
- Code blocks: [N]
- Target lines: 800-1500
- Target words: 3000-6000
```

### Frontmatter Rules

- **Title**: Use format "Primary Topic: Descriptive Subtitle" — be SEO-friendly and specific
- **Date**: Use a future date in 2026 (format: `2026-MM-DDT09:00:00-05:00`)
- **Tags**: 7-12 specific, relevant tags (technologies, concepts, tools)
- **Categories**: 1-3 broad categories (e.g., "Kubernetes", "DevOps", "Cloud Native")
- **Author**: Always `"Matthew Mattox - mmattox@support.tools"`
- **Description**: 150-200 characters, SEO-optimized summary
- **URL**: Lowercase, hyphenated, no special characters, matches the filename slug

### Content Structure Rules

- Use `##` for major sections, `###` for subsections
- Plan code blocks with specific language tags (`bash`, `yaml`, `go`, `python`, `json`, `hcl`)
- Include both conceptual explanation AND practical implementation in each section
- Plan at least one YAML/configuration example for infrastructure topics
- Plan at least one bash command sequence for operational topics
- End with a conclusion that has bullet-point takeaways

### After Presenting the Outline

Ask the user:
1. Does the scope and angle look right?
2. Any sections to add, remove, or reorder?
3. Any specific code examples or scenarios to include?
4. Is the frontmatter (title, tags, URL) acceptable?
