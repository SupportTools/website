# Blog Research

Research the topic "$ARGUMENTS" to gather sources, technical details, and context for writing a blog post on support.tools.

## Instructions

You are researching the topic: **$ARGUMENTS**

### Step 1: Check Existing Coverage

Before researching externally, quickly check what already exists on the blog:

1. Use Grep to search `blog/content/post/` for filenames and titles related to the topic keywords
2. If direct matches exist, Read their frontmatter and introduction (first 30 lines) to understand existing coverage
3. Note what angles are already covered so the new post can differentiate

### Step 2: Web Research

Use WebSearch to find authoritative sources. Run 3-5 searches with different angles:

1. **Official documentation** — Search for the technology's official docs, release notes, or specification
2. **Technical deep-dives** — Search for engineering blog posts, conference talks, or case studies
3. **GitHub repositories** — Search for relevant repos, issues, or pull requests with real-world usage
4. **Known issues / CVEs** — Search for security advisories, common pitfalls, or production incidents
5. **Benchmarks / comparisons** — Search for performance data, comparison articles, or migration guides

Example searches for "Cilium BGP Kubernetes":
- `Cilium BGP documentation 2025 2026`
- `Cilium BGP Kubernetes production deployment`
- `Cilium BGP vs MetalLB comparison`
- `Cilium BGP CVE security advisory`
- `Cilium BGP performance benchmarks`

### Step 3: Deep-Dive Top Sources

Use WebFetch on the top 3-5 most relevant sources to extract detailed technical information:

- Configuration examples and code snippets
- Architecture diagrams or component descriptions
- Version-specific features or breaking changes
- Production recommendations and best practices
- Common troubleshooting scenarios

### Step 4: Compile Research Brief

Present the research as a structured brief:

```
## Research Brief: [topic]

### Topic Summary
[2-3 sentence overview of what this topic is and why it matters]

### Key Technical Details
- [Detail 1 with source]
- [Detail 2 with source]
- [Detail 3 with source]

### Existing Blog Coverage
- [List any existing posts and their angle, or "No existing coverage"]

### Recommended Angle
[Specific angle for the blog post that adds unique value]
[What differentiates this from existing content online and on the blog]

### Source Material
1. [Source title](URL) — [what it provides]
2. [Source title](URL) — [what it provides]
3. [Source title](URL) — [what it provides]

### Suggested Sections
- [Section idea 1 — based on source material available]
- [Section idea 2]
- [Section idea 3]

### Code Examples Available
- [What code/YAML/config examples can be sourced or adapted]

### Open Questions
- [Any gaps in available information that need the user's input]
```

### Important

- Focus on enterprise-grade, production-relevant information — this blog targets experienced engineers
- Prefer primary sources (official docs, GitHub) over secondary summaries
- Note version numbers — the blog content should be current and accurate
- Flag any conflicting information between sources
- If a topic is too broad, suggest a focused angle in the recommendation
