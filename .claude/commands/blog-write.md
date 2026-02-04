# Blog Post Writer

Write the full blog post for the file "$ARGUMENTS" based on the outline approved in this conversation.

## Instructions

You are writing a complete blog post. The argument may be a filename or a topic.

- If `$ARGUMENTS` ends in `.md` — treat it as a target filename in `blog/content/post/`
- Otherwise — treat it as a topic and generate the filename using the naming convention (lowercase, hyphens, no special chars)

### Step 1: Gather Context

1. **Check for approved outline**: Look back through the conversation for an outline that was presented and approved by the user. If no outline exists, inform the user they should run `/blog-outline <topic>` first, or ask if they want you to generate one now.

2. **Read the template**: Read `blog/_template.md` to confirm the frontmatter format.

3. **Read 1-2 similar posts**: Use Grep to find posts with similar tags or topics, then Read the first 80 lines to match the writing style and depth.

### Step 2: Writing Style Rules

Follow these rules strictly — they match the established style of 300+ existing posts:

**Tone and voice:**
- Enterprise-focused, highly technical
- No first-person pronouns ("I", "we", "my") — use passive voice or direct address
- Authoritative but not arrogant — cite real-world scenarios
- Assume the reader is an experienced engineer, not a beginner

**Structure:**
- `##` for major sections, `###` for subsections — never use `#` (reserved for Hugo title)
- `<!--more-->` tag after the introduction paragraph(s)
- Bold (`**term**`) for key terms on first use
- Inline code (`` `command` ``) for commands, paths, config keys, API endpoints
- Each major section should have both explanatory prose AND a practical code example

**Code blocks:**
- Always include a language tag: ````bash`, ````yaml`, ````go`, ````python`, ````json`, ````hcl`
- YAML blocks should include inline comments explaining key fields
- Bash blocks should have `#` comments above non-obvious commands
- Use realistic values (real package names, plausible IPs, actual tool flags)
- Never use placeholder values like `xxx`, `your-value-here`, or `TODO`

**Conclusion:**
- Brief summary paragraph
- Bullet-point list of 3-5 key takeaways
- No call-to-action or self-promotion

### Step 3: Write Section by Section

Write the post in order, section by section. For each section:

1. Write the prose content (2-4 paragraphs per major section)
2. Write any code blocks with proper language tags and comments
3. **Validate code blocks** after writing each section:
   - **YAML**: Write to a temp file in the scratchpad directory and validate with `python3 -c "import yaml; yaml.safe_load(open('file'))"`
   - **Bash**: Validate syntax with `bash -n <(echo '...')`
   - **JSON**: Validate with `python3 -c "import json; json.loads('...')"`
   - **Go**: Write to temp file, run `gofmt` to check formatting
4. If validation fails, fix the code block before moving on

### Step 4: Assemble and Write the File

Once all sections are written:

1. Assemble the complete post: frontmatter + introduction + `<!--more-->` + all sections + conclusion
2. Write the file to `blog/content/post/[filename].md` using the Write tool
3. Verify the file was written by reading back the first 20 lines

### Step 5: Report Statistics

After writing, report:

```
## Post Written Successfully

**File**: `blog/content/post/[filename].md`
**Title**: [title from frontmatter]
**URL**: [url from frontmatter]

### Stats
- Lines: [N]
- Words: ~[N]
- Sections: [N] (## headings)
- Subsections: [N] (### headings)
- Code blocks: [N]
- Code validation: [N passed / N total]

### Code Blocks
1. [language] — [description] — ✅ valid / ❌ [error]
2. ...
```

Then ask the user if they want any revisions.

### Important Reminders

- Target 800-1500 lines for a comprehensive post
- Every YAML, JSON, and bash code block must be validated
- Do not truncate sections or use "..." placeholders — write complete content
- Do not add emoji to the post content
- Do not add a `#` title heading — Hugo generates this from the frontmatter title
