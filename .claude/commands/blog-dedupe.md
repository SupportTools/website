# Blog Deduplication Check

Check whether the topic "$ARGUMENTS" is already covered by existing blog posts on support.tools.

## Instructions

You are checking for existing coverage of the topic: **$ARGUMENTS**

### Step 1: Extract Keywords

Break the topic into 2-4 core keywords. For example:
- "Cilium BGP Kubernetes" → keywords: `cilium`, `bgp`, `kubernetes`
- "Go error handling patterns" → keywords: `go`, `error`, `handling`, `patterns`

### Step 2: Search Existing Posts by Filename

Use Glob to list all files in `blog/content/post/`:
```
blog/content/post/*.md
```

Then use Grep to search filenames and post titles for each keyword. Search both:
1. **Filenames** — Glob pattern matching against the keyword
2. **Frontmatter titles** — Grep for the keyword inside `title:` lines across all posts

### Step 3: Categorize Matches

For each match found, categorize it as:

- **Direct match** — The existing post covers the same core topic (e.g., searching for "cilium ebpf" and finding `cilium-ebpf-networking-deep-dive.md`)
- **Partial overlap** — The existing post covers a related subtopic or mentions the topic in a broader context
- **Tangential** — The post mentions a keyword but covers a substantially different topic

### Step 4: Read Top Matches

For any **direct match** or **partial overlap**, Read the first 30 lines of the post to examine the frontmatter (title, description, tags) and introduction. This helps determine the actual scope of coverage.

### Step 5: Report Results

Present findings in this format:

```
## Deduplication Report: [topic]

### Direct Matches (same topic already covered)
- `filename.md` — "Post Title" — [brief description of overlap]

### Partial Overlaps (related content exists)
- `filename.md` — "Post Title" — [what it covers vs. what the new topic would add]

### Tangential (keyword match, different topic)
- `filename.md` — "Post Title" — [why it's not a real conflict]

### Recommendation
[One of:]
- ✅ **No significant overlap** — safe to proceed with a new post
- ⚠️ **Partial overlap exists** — consider [specific angle] to differentiate
- ❌ **Direct duplicate** — existing post `filename.md` already covers this topic
```

### Important

- There are 300+ existing posts. Be thorough but efficient — search by keyword, don't read every file.
- A topic can still be worth writing about even with partial overlap, if the angle is sufficiently different.
- Always report what you found, even if the answer is "no matches."
