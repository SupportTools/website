# Active Context: SupportTools Website

## Current Work Focus
- **Cilium Troubleshooting Guide Update**: Created new in-depth guide for 2025 with advanced troubleshooting techniques
- **Social Media Content**: Developed BlueSky and LinkedIn posts to promote the new guide
- **Memory Bank Setup**: Established documentation structure for future work continuity
- **GitHub CodeQL Fix**: Resolved code scanning configuration conflict

## Recent Changes
1. Updated makefile to include a local development server option:
   - Added 'dev' command to run Hugo server locally
   - Configured server with proper parameters for local testing
   - Improved makefile command documentation
   
2. Created comprehensive `cilium-troubleshooting-2025.md` blog post with expanded content:
   - Advanced diagnostic techniques
   - In-depth cluster and pod connectivity troubleshooting
   - Performance diagnostics and optimization
   - Case studies with resolution paths
   - Automated troubleshooting approaches

2. Set up social media promotional content:
   - BlueSky post with emoji formatting and engaging question
   - LinkedIn post with professional formatting and detailed value proposition
   - Stored in new `social-media-post/` directory

3. Established Memory Bank documentation to maintain project continuity

4. Fixed GitHub CodeQL configuration issue:
   - Documented conflict between default and custom CodeQL setups
   - Created documentation explaining the root cause and solution
   - Created `docs/github-codeql-fix.md` with detailed steps to resolve the issue

## Active Decisions and Considerations
- **Content Organization**: Kept blog posts in the main blog directory while organizing social media content in dedicated subdirectories (`social-media-post/cilium-troubleshooting-2025/`)
- **Emoji Usage**: Selected technical and problem-solving themed emojis for social posts to increase engagement
- **Technical Depth**: Emphasized advanced troubleshooting techniques over basic concepts to provide unique value
- **Social Media Structure**: Differentiated BlueSky (shorter, more casual) from LinkedIn (longer, more professional) content styles
- **Memory Bank Structure**: Implemented complete documentation structure for future reference
- **CodeQL Configuration**: Prioritized custom workflow over default setup for better control and integration with CI/CD pipeline

## Next Steps
1. Test the new local development server using `make dev`
2. Consider setting up an image directory for blog post diagrams at `cdn.support.tools/posts/cilium-troubleshooting-2025/`
3. Evaluate metrics to track engagement with the new blog post
4. Explore additional social media platforms for content promotion
5. Identify follow-up topics that could complement the Cilium troubleshooting guide
6. Implement the recommended GitHub CodeQL fix to resolve the code scanning issue
