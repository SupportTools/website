# Active Context: SupportTools Website

## Current Work Focus
- **CKA Exam Preparation Guide**: Created comprehensive 10-part training series for Certified Kubernetes Administrator exam preparation
- **Cilium Troubleshooting Guide Update**: Created new in-depth guide for 2025 with advanced troubleshooting techniques
- **Social Media Content**: Developed BlueSky and LinkedIn posts to promote the new guide
- **Memory Bank Setup**: Established documentation structure for future work continuity
- **GitHub CodeQL Fix**: Resolved code scanning configuration conflict
- **CDN-Wasabi Integration**: Implemented automated CDN synchronization to Wasabi cloud storage

## Recent Changes
1. Created comprehensive CKA Exam Preparation Guide:
   - 10-part series with detailed explanations of all CKA exam domains
   - Structured content from introduction to final exam preparation tips
   - Included practical examples, commands, and YAML manifests
   - Added mock exam questions with detailed solutions
   - Followed established training series format based on RKE2 Hard Way

2. Updated makefile to include a local development server option:
   - Added 'dev' command to run Hugo server locally
   - Configured server with proper parameters for local testing
   - Improved makefile command documentation
   
3. Created comprehensive `cilium-troubleshooting-2025.md` blog post with expanded content:
   - Advanced diagnostic techniques
   - In-depth cluster and pod connectivity troubleshooting
   - Performance diagnostics and optimization
   - Case studies with resolution paths
   - Automated troubleshooting approaches

4. Set up social media promotional content:
   - BlueSky post with emoji formatting and engaging question
   - LinkedIn post with professional formatting and detailed value proposition
   - Stored in new `social-media-post/` directory

5. Established Memory Bank documentation to maintain project continuity

6. Fixed GitHub CodeQL configuration issue:
   - Documented conflict between default and custom CodeQL setups
   - Created documentation explaining the root cause and solution
   - Created `docs/github-codeql-fix.md` with detailed steps to resolve the issue

7. Implemented CDN synchronization to Wasabi:
   - Created dedicated GitHub Actions workflow for manual syncing (`wasabi-sync.yml`)
   - Integrated automatic CDN sync with main deployment pipeline for production environments
   - Configured sync to preserve existing files on the Wasabi bucket (no deletion)
   - Used AWS S3 sync command with Wasabi endpoint for optimal compatibility
   - Configured appropriate IAM credentials securely in GitHub Secrets

## Active Decisions and Considerations
- **Training Series Structure**: Organized CKA content into logical sections following established blog training series pattern
- **Kubernetes Best Practices**: Emphasized current Kubernetes best practices in all examples and solutions
- **Practical Approach**: Focused on hands-on, practical instructions with real-world examples rather than theoretical knowledge
- **Content Organization**: Kept blog posts in the main blog directory while organizing social media content in dedicated subdirectories
- **Technical Depth**: Emphasized advanced troubleshooting techniques over basic concepts to provide unique value
- **Memory Bank Structure**: Implemented complete documentation structure for future reference
- **CodeQL Configuration**: Prioritized custom workflow over default setup for better control and integration with CI/CD pipeline
- **CDN Sync Strategy**: Implemented additive-only sync to Wasabi to prevent accidental file deletion

## Next Steps
1. Test the new CKA Exam Preparation Guide with actual students to gather feedback
2. Consider creating accompanying diagrams for the CKA series at `cdn.support.tools/training/cka-prep/`
3. Evaluate developing similar training series for CKAD and CKS certifications
4. Test the new local development server using `make dev`
5. Consider setting up an image directory for blog post diagrams at `cdn.support.tools/posts/cilium-troubleshooting-2025/`
6. Evaluate metrics to track engagement with the new content
7. Explore additional social media platforms for content promotion
8. Implement the recommended GitHub CodeQL fix to resolve the code scanning issue
9. Test the new Wasabi CDN synchronization workflow with a manual trigger
10. Monitor the first few automatic CDN syncs during deployment to ensure proper functionality
