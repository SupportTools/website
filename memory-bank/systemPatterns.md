# System Patterns: SupportTools Website

## System Architecture
The SupportTools website is built using:
- Hugo static site generator for the blog
- Markdown content files
- Go-based main application
- Container-based deployment

The site follows a static-first architecture with minimal dynamic components, prioritizing performance and reliability.

## Key Technical Decisions
1. **Static Site Generation**: Using Hugo for performance and simplicity
2. **Markdown Content**: Enables version control and easy editing of technical content
3. **Container Deployment**: Facilitates consistent deployment across environments
4. **Separate Content Directories**: Organizing content by type (blog posts, training, etc.)
5. **Social Media Integration**: Dedicated directory for social media content

## Design Patterns
- **Content Separation**: Blog content is separated from the main application code
- **Directory Structure**:
  - `blog/content/post/` - Main blog post content
  - `social-media-post/` - Social media promotional content
  - `blog/static/` - Static assets and resources
  - `cdn.support.tools/` - CDN-hosted resources

## Component Relationships
```
Hugo Static Site Generator
        ↓
    Markdown Content
        ↓
    Static HTML/CSS/JS
        ↓
    Containerized Deployment
        ↓
    Public Website
```

## Content Structure
Blog posts follow a standardized structure:
1. Front matter (title, date, tags, categories, etc.)
2. Introduction with summary
3. Main content with clear section headers
4. Code examples and commands where applicable
5. Conclusion or summary

## Workflow Patterns
1. Content creation and updates
2. Social media post creation for promotion
3. Deployment via containerization
4. CDN resource management for images and large assets
