# Blog Post Review

Review the blog post "$ARGUMENTS" against the support.tools blog standards and report any issues.

## Instructions

You are reviewing a blog post for quality, correctness, and adherence to standards.

### Step 1: Locate the Post

- If `$ARGUMENTS` ends in `.md` — look for `blog/content/post/$ARGUMENTS`
- If `$ARGUMENTS` does not end in `.md` — look for `blog/content/post/$ARGUMENTS.md`
- If neither exists, use Grep to search for the argument in post titles and filenames, then ask the user to confirm which post to review

Read the entire post content.

### Step 2: Frontmatter Validation

Check each frontmatter field against the template (`blog/_template.md`):

| Field | Check |
|-------|-------|
| `title` | Present, non-empty, SEO-friendly (includes descriptive subtitle) |
| `date` | Valid ISO 8601 format with timezone (`2026-MM-DDT09:00:00-05:00`) |
| `draft` | Must be `false` for publishable posts |
| `tags` | Array of 7-12 specific tags, properly quoted |
| `categories` | 1-3 broad categories |
| `author` | Must be `"Matthew Mattox - mmattox@support.tools"` |
| `description` | 150-200 characters, SEO-friendly summary |
| `more_link` | Must be `"yes"` |
| `url` | Starts and ends with `/`, lowercase, hyphenated, no special chars |

### Step 3: Structure Validation

Check the post structure:

- [ ] Introduction paragraph(s) appear before `<!--more-->`
- [ ] `<!--more-->` tag is present
- [ ] Uses `##` for major sections (not `#`)
- [ ] Uses `###` for subsections
- [ ] Conclusion section exists
- [ ] Conclusion includes bullet-point takeaways
- [ ] No `#` single-hash headings (Hugo generates the title)
- [ ] No empty sections (heading with no content)

### Step 4: Writing Style Validation

Check style conventions:

- [ ] No first-person pronouns ("I", "we", "my", "our")
- [ ] Key terms are bolded on first use
- [ ] Commands, paths, and config keys use inline code
- [ ] Technical tone — enterprise-focused, no casual language
- [ ] No emoji in the post content
- [ ] No placeholder values ("xxx", "your-value-here", "TODO", "example.com" in non-example contexts)

### Step 5: Code Block Validation

For every code block in the post:

1. **Check language tag** — every code block must have a language tag (```bash, ```yaml, etc.)
2. **Validate syntax** — use the appropriate method:

   **YAML blocks:**
   ```bash
   python3 -c "import yaml; yaml.safe_load('''[paste yaml]''')"
   ```

   **Bash blocks:**
   ```bash
   bash -n <(echo '[paste bash]')
   ```

   **JSON blocks:**
   ```bash
   python3 -c "import json; json.loads('''[paste json]''')"
   ```

   **Go blocks:**
   Write to a temp file in the scratchpad directory and run `gofmt` to check formatting.

3. **Check comments** — YAML should have inline comments on key fields, bash should have `#` comments above non-obvious commands

### Step 6: Content Quality Check

- [ ] Post is 800-1500 lines (flag if outside this range with the actual count)
- [ ] Each major section has both prose explanation AND practical examples
- [ ] Code examples use realistic values
- [ ] No broken markdown (unclosed bold, unclosed code blocks, orphaned links)
- [ ] URL in frontmatter matches the filename slug

### Step 7: Duplicate Check

Use Grep to search for the post's main topic keywords in other post filenames and titles. Report any potential overlaps.

### Step 8: Report

Present the review in this format:

```
## Blog Post Review: [filename]

### Summary
- **Title**: [title]
- **Lines**: [N]
- **Words**: ~[N]
- **Sections**: [N]
- **Code blocks**: [N]

### Frontmatter
[✅ or ❌ for each field, with details on failures]

### Structure
[✅ or ❌ for each check]

### Writing Style
[✅ or ❌ for each check, with examples of violations]

### Code Blocks
1. [language] line [N] — ✅ valid / ❌ [specific error]
2. ...

### Content Quality
[✅ or ❌ for each check]

### Duplicate Check
[Results or "No significant overlaps found"]

### Overall Rating
[One of:]
- ✅ **Ready to publish** — no issues found
- ⚠️ **Minor issues** — [N] items to fix before publishing
- ❌ **Needs revision** — [N] significant issues found

### Issues to Fix (if any)
1. [Priority] [Description] — line [N]
2. ...
```
