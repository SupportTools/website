---
title: "Automating GitHub Pull Request Reporting: Building a Comprehensive PR Analytics System"
date: 2026-04-23T09:00:00-05:00
draft: false
tags: ["GitHub", "GitHub Actions", "Python", "Automation", "Pull Requests", "DevOps", "Reporting", "API", "CI/CD", "Development Metrics"]
categories:
- GitHub
- Automation
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Build a powerful GitHub PR analytics system with Python and GitHub Actions. This comprehensive guide covers advanced API integration, pagination handling, rich HTML reports, and secure token management for tracking merged pull requests across your entire organization."
more_link: "yes"
url: "/github-pull-request-reporting-automation/"
---

![GitHub PR Reporting System](/images/posts/github/pr-reporting-dashboard.svg)

Learn how to build a sophisticated GitHub Pull Request reporting system that monitors PR activity across your entire organization. This guide walks through creating a robust Python script, implementing a flexible GitHub Actions workflow, and generating rich HTML reports with actionable PR metrics and insights.

<!--more-->

# [Building a GitHub Pull Request Analytics System](#github-pr-analytics)

## [Introduction to PR Metrics and Reporting](#pr-metrics-introduction)

Monitoring pull request activity across an organization provides vital insights into development velocity, code review efficiency, and team collaboration patterns. However, the GitHub UI doesn't offer comprehensive cross-repository analytics, especially for organizations with many repositories.

This guide will walk you through creating a powerful pull request reporting system that:

1. Tracks all merged pull requests across an entire GitHub organization
2. Provides detailed metrics including approvers, merge times, and PR sizes
3. Generates rich, filterable HTML reports
4. Runs automatically on a schedule or via manual trigger
5. Implements proper pagination, error handling, and security best practices

## [Understanding the GitHub API for Pull Requests](#github-api-overview)

Before diving into implementation, let's understand how GitHub's API represents pull requests and what data we can access.

### [Key GitHub API Endpoints](#api-endpoints)

The primary endpoints we'll use are:

1. **List Organization Repositories**: `GET /orgs/{org}/repos`
2. **List Pull Requests**: `GET /repos/{owner}/{repo}/pulls`
3. **Get Pull Request Details**: `GET /repos/{owner}/{repo}/pulls/{pull_number}`
4. **List Pull Request Reviews**: `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`

### [Authentication and Rate Limiting](#api-authentication)

GitHub API requests require authentication and are subject to rate limits:

- Authenticated requests have a higher rate limit (5,000 requests per hour)
- Personal Access Tokens (PATs) or GitHub Apps can be used for authentication
- Each response includes rate limit information in the headers

### [Pagination Handling](#api-pagination)

GitHub API responses are paginated, with each page containing a limited number of items (typically 30):

- The `Link` header provides URLs for the next, previous, first, and last pages
- To fetch all items, we must follow the "next" link until no more pages are available

## [Designing the Python Script](#python-script)

Let's build a comprehensive Python script for PR reporting with proper error handling, pagination, and formatted output.

### [Script Architecture](#script-architecture)

Our script will have these key components:

1. **Configuration Handler**: Manages API tokens, organization settings, and filter options
2. **API Client**: Handles GitHub API requests with authentication and pagination
3. **Data Processors**: Extract and transform PR data into useful metrics
4. **Report Generator**: Creates formatted HTML output

### [The Enhanced PR Reporting Script](#enhanced-script)

Here's our improved Python script (`github_pr_report.py`):

```python
#!/usr/bin/env python3
"""
GitHub Pull Request Reporter

Generates a comprehensive report of merged pull requests across an organization.
Features proper pagination, error handling, and rich HTML output.
"""

import os
import sys
import time
import argparse
import requests
from datetime import datetime, timedelta
import json
import re
from urllib.parse import urlparse, parse_qs

# Configuration
DEFAULT_DAYS = 7
MAX_RETRIES = 3
RETRY_BACKOFF = 2  # seconds

class GitHubAPIClient:
    """Handles all GitHub API requests with pagination and rate limiting."""
    
    def __init__(self, token, org):
        self.token = token
        self.org = org
        self.base_url = "https://api.github.com"
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'token {token}',
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'GitHub-PR-Reporter'
        })
        self.rate_limit_remaining = None
        self.rate_limit_reset = None
    
    def _handle_rate_limit(self):
        """Handle rate limiting by waiting if necessary."""
        if self.rate_limit_remaining is not None and self.rate_limit_remaining < 10:
            now = time.time()
            if self.rate_limit_reset is not None and now < self.rate_limit_reset:
                wait_time = self.rate_limit_reset - now + 1
                print(f"⚠️ Rate limit almost reached. Waiting {wait_time:.0f} seconds...", file=sys.stderr)
                time.sleep(wait_time)
    
    def _update_rate_limit(self, headers):
        """Update rate limit information from response headers."""
        try:
            self.rate_limit_remaining = int(headers.get('X-RateLimit-Remaining', 0))
            self.rate_limit_reset = int(headers.get('X-RateLimit-Reset', 0))
        except (ValueError, TypeError):
            pass
    
    def _get_next_page_url(self, link_header):
        """Extract next page URL from Link header."""
        if not link_header:
            return None
            
        links = {}
        for link in link_header.split(','):
            match = re.match(r'<(.+)>;\s*rel="([^"]+)"', link.strip())
            if match:
                links[match.group(2)] = match.group(1)
        
        return links.get('next')
    
    def request(self, method, endpoint, params=None, data=None):
        """Make a request to the GitHub API with retry logic and rate limit handling."""
        url = f"{self.base_url}{endpoint}"
        retry_count = 0
        
        while retry_count < MAX_RETRIES:
            self._handle_rate_limit()
            
            try:
                response = self.session.request(
                    method=method,
                    url=url,
                    params=params,
                    json=data
                )
                
                self._update_rate_limit(response.headers)
                
                if response.status_code == 200:
                    return response
                
                if response.status_code == 404:
                    print(f"⚠️ Resource not found: {url}", file=sys.stderr)
                    return None
                
                if response.status_code == 403 and 'rate limit exceeded' in response.text.lower():
                    reset_time = int(response.headers.get('X-RateLimit-Reset', 0))
                    wait_time = max(reset_time - time.time() + 1, 0)
                    print(f"⚠️ Rate limit exceeded. Waiting {wait_time:.0f} seconds...", file=sys.stderr)
                    time.sleep(wait_time)
                    retry_count += 1
                    continue
                
                print(f"⚠️ API request failed: {response.status_code} - {response.text}", file=sys.stderr)
                
            except requests.RequestException as e:
                print(f"⚠️ Request error: {e}", file=sys.stderr)
            
            # Exponential backoff
            wait_time = RETRY_BACKOFF * (2 ** retry_count)
            print(f"⚠️ Retrying in {wait_time} seconds... (Attempt {retry_count + 1}/{MAX_RETRIES})", file=sys.stderr)
            time.sleep(wait_time)
            retry_count += 1
        
        print(f"❌ Failed after {MAX_RETRIES} attempts: {url}", file=sys.stderr)
        return None
    
    def paginated_request(self, method, endpoint, params=None, data=None):
        """Request that handles GitHub pagination automatically."""
        if params is None:
            params = {}
        
        # Set a higher per_page value to reduce the number of API calls
        params['per_page'] = 100
        
        all_results = []
        current_url = f"{self.base_url}{endpoint}"
        
        while current_url:
            parsed_url = urlparse(current_url)
            if parsed_url.query:
                # For subsequent pages, we need to use the exact URL GitHub provided
                current_params = None
                current_endpoint = current_url.replace(self.base_url, '')
            else:
                # For the first page, use the provided parameters
                current_params = params
                current_endpoint = endpoint
                
            response = self.request(method, current_endpoint, params=current_params, data=data)
            
            if not response:
                break
                
            try:
                results = response.json()
                
                if isinstance(results, list):
                    all_results.extend(results)
                else:
                    # If the response is not a list, just return it
                    return results
                    
            except ValueError:
                print(f"❌ Failed to parse JSON from response", file=sys.stderr)
                break
                
            # Check for more pages
            next_url = self._get_next_page_url(response.headers.get('Link'))
            current_url = next_url
            
        return all_results
    
    def get_repositories(self):
        """Get all repositories for the organization."""
        print(f"📊 Fetching repositories for {self.org}...", file=sys.stderr)
        return self.paginated_request('GET', f'/orgs/{self.org}/repos', params={'type': 'all'})
    
    def get_pull_requests(self, repo_name, state='all'):
        """Get pull requests for a repository."""
        print(f"📊 Fetching pull requests for {repo_name}...", file=sys.stderr)
        return self.paginated_request(
            'GET', 
            f'/repos/{self.org}/{repo_name}/pulls', 
            params={'state': state, 'sort': 'updated', 'direction': 'desc'}
        )
    
    def get_pull_request_reviews(self, repo_name, pr_number):
        """Get reviews for a specific pull request."""
        return self.paginated_request('GET', f'/repos/{self.org}/{repo_name}/pulls/{pr_number}/reviews')
    
    def get_pull_request_files(self, repo_name, pr_number):
        """Get files changed in a specific pull request."""
        return self.paginated_request('GET', f'/repos/{self.org}/{repo_name}/pulls/{pr_number}/files')


class PRMetricsCalculator:
    """Calculates metrics based on PR data."""
    
    @staticmethod
    def calculate_size_label(additions, deletions):
        """Calculate PR size label based on changes."""
        total_changes = additions + deletions
        
        if total_changes <= 10:
            return "XS", "#c0e0c0"  # Light green
        elif total_changes <= 50:
            return "S", "#b0d0b0"   # Green
        elif total_changes <= 250:
            return "M", "#f0e0b0"   # Light yellow
        elif total_changes <= 1000:
            return "L", "#f0c0a0"   # Light orange
        else:
            return "XL", "#f0a0a0"  # Light red
    
    @staticmethod
    def calculate_time_to_merge(created_at, merged_at):
        """Calculate time from creation to merge."""
        if not merged_at:
            return None
            
        created_time = datetime.strptime(created_at, '%Y-%m-%dT%H:%M:%SZ')
        merged_time = datetime.strptime(merged_at, '%Y-%m-%dT%H:%M:%SZ')
        
        time_diff = merged_time - created_time
        
        # Format the time difference
        days = time_diff.days
        hours, remainder = divmod(time_diff.seconds, 3600)
        minutes, _ = divmod(remainder, 60)
        
        if days > 0:
            return f"{days}d {hours}h {minutes}m"
        elif hours > 0:
            return f"{hours}h {minutes}m"
        else:
            return f"{minutes}m"
    
    @staticmethod
    def extract_approvers(reviews):
        """Extract unique approvers from reviews."""
        approvers = set()
        
        for review in reviews:
            if review['state'] == 'APPROVED':
                approvers.add(review['user']['login'])
                
        return list(approvers)


class HTMLReportGenerator:
    """Generates HTML reports from PR data."""
    
    def __init__(self):
        self.css_styles = """
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                margin: 0;
                padding: 20px;
                color: #24292e;
                line-height: 1.5;
            }
            .container {
                max-width: 1200px;
                margin: 0 auto;
            }
            h1 {
                border-bottom: 1px solid #eaecef;
                padding-bottom: 10px;
            }
            .summary {
                background-color: #f6f8fa;
                border: 1px solid #e1e4e8;
                border-radius: 6px;
                padding: 15px;
                margin-bottom: 20px;
            }
            .repo-header {
                background-color: #0366d6;
                color: white;
                padding: 10px 15px;
                margin-top: 25px;
                margin-bottom: 5px;
                border-radius: 6px 6px 0 0;
                font-size: 18px;
                font-weight: bold;
            }
            .repo-header a {
                color: white;
                text-decoration: none;
            }
            .repo-header a:hover {
                text-decoration: underline;
            }
            .pr-table {
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 20px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                border-radius: 0 0 6px 6px;
                overflow: hidden;
            }
            .pr-table thead {
                background-color: #f1f1f1;
            }
            .pr-table th {
                text-align: left;
                padding: 10px;
                border-bottom: 2px solid #e1e4e8;
                font-weight: 600;
            }
            .pr-table td {
                padding: 10px;
                border-bottom: 1px solid #e1e4e8;
                vertical-align: top;
            }
            .pr-table tr:last-child td {
                border-bottom: none;
            }
            .pr-table tr:hover {
                background-color: #f6f8fa;
            }
            .pr-number {
                font-family: monospace;
                color: #24292e;
                font-weight: 600;
            }
            .pr-title {
                font-weight: 600;
                color: #0366d6;
            }
            .pr-title a {
                text-decoration: none;
                color: #0366d6;
            }
            .pr-title a:hover {
                text-decoration: underline;
            }
            .pr-meta {
                color: #586069;
                font-size: 85%;
                margin-top: 5px;
            }
            .pr-author {
                color: #24292e;
                font-weight: 600;
            }
            .pr-approvers {
                margin-top: 5px;
            }
            .approver {
                display: inline-block;
                background-color: #eaf5ff;
                border: 1px solid #c8e1ff;
                border-radius: 3px;
                padding: 2px 6px;
                margin-right: 5px;
                margin-bottom: 5px;
                font-size: 85%;
            }
            .size-label {
                display: inline-block;
                border-radius: 3px;
                padding: 2px 6px;
                font-size: 85%;
                font-weight: 600;
            }
            .merge-time {
                color: #586069;
                font-size: 85%;
            }
            .filters {
                margin-bottom: 20px;
                padding: 15px;
                background-color: #f6f8fa;
                border: 1px solid #e1e4e8;
                border-radius: 6px;
            }
            .filter-input {
                padding: 8px;
                border: 1px solid #e1e4e8;
                border-radius: 3px;
                margin-right: 10px;
                width: 200px;
            }
            .filter-button {
                padding: 8px 16px;
                background-color: #0366d6;
                color: white;
                border: none;
                border-radius: 3px;
                cursor: pointer;
            }
            .filter-button:hover {
                background-color: #0256b9;
            }
            .empty-message {
                padding: 20px;
                background-color: #f6f8fa;
                border: 1px solid #e1e4e8;
                border-radius: 6px;
                text-align: center;
                color: #586069;
            }
        </style>
        """
        
        self.filter_script = """
        <script>
            document.addEventListener('DOMContentLoaded', function() {
                const repoFilter = document.getElementById('repoFilter');
                const authorFilter = document.getElementById('authorFilter');
                const applyFilterButton = document.getElementById('applyFilter');
                const resetFilterButton = document.getElementById('resetFilter');
                
                function applyFilters() {
                    const repoValue = repoFilter.value.toLowerCase();
                    const authorValue = authorFilter.value.toLowerCase();
                    
                    // Get all repo sections
                    const repoSections = document.querySelectorAll('.repo-section');
                    
                    let visibleRepos = 0;
                    let totalPRs = 0;
                    let visiblePRs = 0;
                    
                    repoSections.forEach(function(section) {
                        const repoName = section.getAttribute('data-repo-name').toLowerCase();
                        const repoMatch = repoValue === '' || repoName.includes(repoValue);
                        
                        let visiblePRsInRepo = 0;
                        
                        // Get all PR rows in this repo
                        const prRows = section.querySelectorAll('.pr-row');
                        
                        prRows.forEach(function(row) {
                            const author = row.getAttribute('data-author').toLowerCase();
                            const authorMatch = authorValue === '' || author.includes(authorValue);
                            
                            totalPRs++;
                            
                            if (repoMatch && authorMatch) {
                                row.style.display = '';
                                visiblePRsInRepo++;
                                visiblePRs++;
                            } else {
                                row.style.display = 'none';
                            }
                        });
                        
                        // Show/hide the entire repo section based on whether any PRs are visible
                        if (visiblePRsInRepo > 0) {
                            section.style.display = '';
                            visibleRepos++;
                        } else {
                            section.style.display = 'none';
                        }
                    });
                    
                    // Update summary counts
                    document.getElementById('visibleRepos').textContent = visibleRepos;
                    document.getElementById('visiblePRs').textContent = visiblePRs;
                    document.getElementById('totalPRs').textContent = totalPRs;
                }
                
                applyFilterButton.addEventListener('click', applyFilters);
                
                resetFilterButton.addEventListener('click', function() {
                    repoFilter.value = '';
                    authorFilter.value = '';
                    applyFilters();
                });
                
                // Apply filters on load to set initial counts
                applyFilters();
            });
        </script>
        """
    
    def generate_report_header(self, org_name, days, timestamp):
        """Generate the HTML report header."""
        return f"""
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>GitHub PR Report - {org_name} - Past {days} Days</title>
            {self.css_styles}
        </head>
        <body>
            <div class="container">
                <h1>GitHub Pull Request Report - {org_name}</h1>
                
                <div class="summary">
                    <p>Report generated on <strong>{timestamp}</strong></p>
                    <p>Showing merged pull requests from the past <strong>{days} days</strong></p>
                    <p>
                        Displaying <strong><span id="visiblePRs">0</span></strong> of 
                        <strong><span id="totalPRs">0</span></strong> merged PRs 
                        across <strong><span id="visibleRepos">0</span></strong> repositories
                    </p>
                </div>
                
                <div class="filters">
                    <input type="text" id="repoFilter" class="filter-input" placeholder="Filter by repository...">
                    <input type="text" id="authorFilter" class="filter-input" placeholder="Filter by author...">
                    <button id="applyFilter" class="filter-button">Apply Filters</button>
                    <button id="resetFilter" class="filter-button">Reset</button>
                </div>
        """
    
    def generate_report_footer(self):
        """Generate the HTML report footer."""
        return f"""
                {self.filter_script}
            </div>
        </body>
        </html>
        """
    
    def generate_repo_section_header(self, repo_name, repo_url):
        """Generate the header for a repository section."""
        return f"""
        <div class="repo-section" data-repo-name="{repo_name}">
            <div class="repo-header">
                <a href="{repo_url}" target="_blank">{repo_name}</a>
            </div>
            <table class="pr-table">
                <thead>
                    <tr>
                        <th width="15%">PR</th>
                        <th width="35%">Title & Author</th>
                        <th width="20%">Approvers</th>
                        <th width="10%">Size</th>
                        <th width="20%">Metrics</th>
                    </tr>
                </thead>
                <tbody>
        """
    
    def generate_repo_section_footer(self):
        """Generate the footer for a repository section."""
        return """
                </tbody>
            </table>
        </div>
        """
    
    def generate_pr_row(self, pr, metrics):
        """Generate a table row for a pull request."""
        size_label, bgcolor = metrics['size_label']
        
        approvers_html = ""
        if metrics['approvers']:
            approvers_html = "".join([f'<span class="approver">{approver}</span>' for approver in metrics['approvers']])
        else:
            approvers_html = "<em>No approvers</em>"
            
        merged_time_html = ""
        if metrics['time_to_merge']:
            merged_time_html = f'<div class="merge-time">Merged in: {metrics["time_to_merge"]}</div>'
        
        return f"""
        <tr class="pr-row" data-author="{pr['user']['login']}">
            <td>
                <div class="pr-number">#{pr['number']}</div>
                <div class="pr-meta">Merged: {pr['merged_at'].split('T')[0]}</div>
            </td>
            <td>
                <div class="pr-title"><a href="{pr['html_url']}" target="_blank">{pr['title']}</a></div>
                <div class="pr-meta">by <span class="pr-author">@{pr['user']['login']}</span></div>
            </td>
            <td class="pr-approvers">
                {approvers_html}
            </td>
            <td>
                <span class="size-label" style="background-color: {bgcolor};">{size_label}</span>
                <div class="pr-meta">+{pr['additions']} / -{pr['deletions']}</div>
            </td>
            <td>
                {merged_time_html}
                <div class="pr-meta">Comments: {metrics['comment_count']}</div>
            </td>
        </tr>
        """
    
    def generate_empty_repo_message(self):
        """Generate message for repos with no PRs."""
        return """
        <tr>
            <td colspan="5" class="empty-message">No merged pull requests found in the specified time period.</td>
        </tr>
        """


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description='Generate GitHub PR Report')
    parser.add_argument('--org', type=str, help='GitHub organization name')
    parser.add_argument('--days', type=int, default=DEFAULT_DAYS, help='Number of days to consider')
    parser.add_argument('--token', type=str, help='GitHub personal access token')
    parser.add_argument('--output', type=str, default='pr_report.html', help='Output file path')
    parser.add_argument('--repo', type=str, help='Filter for a specific repository')
    return parser.parse_args()


def main():
    """Main function to run the script."""
    args = parse_arguments()
    
    # Get configuration from args or environment variables
    token = args.token or os.environ.get('GITHUB_TOKEN')
    org = args.org or os.environ.get('ORG')
    days = args.days or int(os.environ.get('DAYS', DEFAULT_DAYS))
    output_file = args.output or os.environ.get('OUTPUT_FILE', 'pr_report.html')
    repo_filter = args.repo or os.environ.get('REPO_FILTER')
    
    if not token:
        print("❌ GitHub token not provided. Use --token argument or set GITHUB_TOKEN environment variable.", file=sys.stderr)
        sys.exit(1)
        
    if not org:
        print("❌ GitHub organization not provided. Use --org argument or set ORG environment variable.", file=sys.stderr)
        sys.exit(1)
    
    # Initialize our components
    github_client = GitHubAPIClient(token, org)
    metrics_calculator = PRMetricsCalculator()
    report_generator = HTMLReportGenerator()
    
    # Calculate date threshold
    current_date = datetime.now()
    date_threshold = current_date - timedelta(days=days)
    
    # Start generating the report
    timestamp = current_date.strftime('%Y-%m-%d %H:%M:%S UTC')
    report = report_generator.generate_report_header(org, days, timestamp)
    
    # Fetch repositories
    repositories = github_client.get_repositories()
    
    if not repositories:
        print(f"❌ No repositories found for organization {org}", file=sys.stderr)
        sys.exit(1)
    
    # Filter repositories if specified
    if repo_filter:
        repositories = [repo for repo in repositories if repo_filter.lower() in repo['name'].lower()]
    
    # Process each repository
    for repo in repositories:
        repo_name = repo['name']
        repo_url = repo['html_url']
        
        # Skip archived repositories
        if repo.get('archived', False):
            print(f"📦 Skipping archived repository: {repo_name}", file=sys.stderr)
            continue
        
        pull_requests = github_client.get_pull_requests(repo_name)
        
        if not pull_requests:
            print(f"ℹ️ No pull requests found in repository: {repo_name}", file=sys.stderr)
            continue
        
        # Filter for merged PRs within the time window
        merged_prs = []
        for pr in pull_requests:
            # Skip PRs that aren't merged
            if not pr.get('merged_at'):
                continue
                
            # Check if within time window
            pr_created_at = datetime.strptime(pr['created_at'], '%Y-%m-%dT%H:%M:%SZ')
            if pr_created_at >= date_threshold:
                merged_prs.append(pr)
        
        if not merged_prs:
            print(f"ℹ️ No merged pull requests in time window for repository: {repo_name}", file=sys.stderr)
            continue
        
        # Start repository section
        report += report_generator.generate_repo_section_header(repo_name, repo_url)
        
        # No merged PRs in time window
        if not merged_prs:
            report += report_generator.generate_empty_repo_message()
        else:
            # Generate rows for each PR
            for pr in merged_prs:
                # Get reviews for this PR
                reviews = github_client.get_pull_request_reviews(repo_name, pr['number'])
                
                # Calculate metrics
                metrics = {
                    'approvers': metrics_calculator.extract_approvers(reviews or []),
                    'time_to_merge': metrics_calculator.calculate_time_to_merge(
                        pr['created_at'], pr['merged_at']
                    ),
                    'size_label': metrics_calculator.calculate_size_label(
                        pr['additions'], pr['deletions']
                    ),
                    'comment_count': len([r for r in reviews or [] if r.get('body')])
                }
                
                # Add PR row to report
                report += report_generator.generate_pr_row(pr, metrics)
        
        # End repository section
        report += report_generator.generate_repo_section_footer()
    
    # Complete the report
    report += report_generator.generate_report_footer()
    
    # Write the report to file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(report)
    
    print(f"✅ Report generated successfully: {output_file}", file=sys.stderr)


if __name__ == '__main__':
    main()
```

### [Understanding the Key Components](#script-components)

Let's break down the key components of our script:

1. **GitHubAPIClient**: Handles all API requests with pagination, rate limiting, and error handling
2. **PRMetricsCalculator**: Computes metrics like PR size, time to merge, and extracts approvers
3. **HTMLReportGenerator**: Creates a rich, interactive HTML report
4. **Main Function**: Coordinates the process, filtering PRs by date range

## [Creating the GitHub Actions Workflow](#github-actions)

Next, let's create an enhanced GitHub Actions workflow that offers more flexibility and features.

### [Enhanced GitHub Actions Workflow](#enhanced-workflow)

Create this file at `.github/workflows/pr-report.yml`:

```yaml
name: Pull Request Report

on:
  # Manual trigger with parameters
  workflow_dispatch:
    inputs:
      days:
        description: 'Number of days to consider'
        required: true
        default: '7'
        type: choice
        options:
          - '1'
          - '3'
          - '7'
          - '14'
          - '30'
          - '90'
      repository:
        description: 'Filter for specific repository (leave empty for all)'
        required: false
        type: string
  
  # Weekly scheduled run
  schedule:
    - cron: '0 0 * * 1'  # Run at midnight every Monday

jobs:
  generate-report:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
          cache: 'pip'

      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install requests

      - name: Determine days parameter
        id: determine-days
        run: |
          if [ "${{ github.event_name }}" == "workflow_dispatch" ]; then
            echo "DAYS=${{ github.event.inputs.days }}" >> $GITHUB_ENV
            echo "REPO_FILTER=${{ github.event.inputs.repository }}" >> $GITHUB_ENV
          else
            echo "DAYS=7" >> $GITHUB_ENV
            echo "REPO_FILTER=" >> $GITHUB_ENV
          fi

      - name: Generate timestamp
        id: timestamp
        run: echo "TIMESTAMP=$(date '+%Y%m%d-%H%M%S')" >> $GITHUB_ENV

      - name: Run PR report script
        run: python github_pr_report.py
        env:
          GITHUB_TOKEN: ${{ secrets.PR_REPORT_TOKEN }}
          ORG: ${{ vars.GITHUB_ORG }}
          DAYS: ${{ env.DAYS }}
          REPO_FILTER: ${{ env.REPO_FILTER }}
          OUTPUT_FILE: pr_report_${{ env.TIMESTAMP }}.html

      - name: Upload report as artifact
        uses: actions/upload-artifact@v3
        with:
          name: pr-report-${{ env.TIMESTAMP }}
          path: pr_report_${{ env.TIMESTAMP }}.html
          retention-days: 90

      - name: Save report to GitHub Pages (if enabled)
        if: ${{ vars.PUBLISH_TO_PAGES == 'true' }}
        run: |
          mkdir -p public
          cp pr_report_${{ env.TIMESTAMP }}.html public/index.html
          cp pr_report_${{ env.TIMESTAMP }}.html public/latest.html
          
          # Create archive directory if it doesn't exist
          mkdir -p public/archive
          
          # Add to archive
          cp pr_report_${{ env.TIMESTAMP }}.html public/archive/pr_report_${{ env.TIMESTAMP }}.html
          
          # Create simple index page to list all reports
          echo "<!DOCTYPE html>
          <html>
          <head>
            <title>PR Report Archive</title>
            <style>
              body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
              h1 { border-bottom: 1px solid #eee; }
              ul { list-style-type: none; padding: 0; }
              li { margin: 10px 0; padding: 10px; background: #f5f5f5; border-radius: 5px; }
              a { text-decoration: none; color: #0366d6; }
              a:hover { text-decoration: underline; }
            </style>
          </head>
          <body>
            <h1>PR Report Archive</h1>
            <p><a href=\"../latest.html\">View Latest Report</a></p>
            <ul>" > public/archive/index.html
          
          # Add links to all reports in archive
          for file in public/archive/pr_report_*.html; do
            filename=$(basename $file)
            date_part=$(echo $filename | sed 's/pr_report_\([0-9]\{8\}-[0-9]\{6\}\).html/\1/')
            formatted_date=$(echo $date_part | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1-\2-\3 \4:\5:\6/')
            echo "              <li><a href=\"$filename\">Report from $formatted_date</a></li>" >> public/archive/index.html
          done
          
          echo "            </ul>
          </body>
          </html>" >> public/archive/index.html

      - name: Deploy to GitHub Pages (if enabled)
        if: ${{ vars.PUBLISH_TO_PAGES == 'true' }}
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./public
          force_orphan: false
          keep_files: true

      - name: Send email notification (if enabled)
        if: ${{ vars.SEND_EMAIL_REPORT == 'true' }}
        uses: dawidd6/action-send-mail@v3
        with:
          server_address: ${{ vars.MAIL_SERVER }}
          server_port: ${{ vars.MAIL_PORT }}
          username: ${{ secrets.MAIL_USERNAME }}
          password: ${{ secrets.MAIL_PASSWORD }}
          subject: "GitHub PR Report: ${{ vars.GITHUB_ORG }} (${{ env.TIMESTAMP }})"
          body: |
            GitHub Pull Request Report for ${{ vars.GITHUB_ORG }}
            
            Time period: Last ${{ env.DAYS }} days
            Generated: ${{ env.TIMESTAMP }}
            
            The report is attached to this email.
          to: ${{ vars.REPORT_RECIPIENTS }}
          from: PR Report <${{ vars.MAIL_FROM }}>
          attachments: pr_report_${{ env.TIMESTAMP }}.html
          content_type: text/html
```

### [Key Workflow Features](#workflow-features)

This enhanced workflow includes several advanced features:

1. **Scheduled and Manual Execution**: Runs weekly and on-demand
2. **Configurable Parameters**: Days to include and optional repository filtering
3. **GitHub Pages Integration**: Automatically publishes reports to GitHub Pages
4. **Report Archive**: Maintains an archive of past reports
5. **Email Notifications**: Optionally sends reports via email

## [Securing Your GitHub Token](#security)

GitHub tokens used for API access need careful handling to prevent security issues.

### [Token Permission Requirements](#token-permissions)

For this report to work correctly, your token needs these permissions:

1. **repo**: For private repository access
2. **read:org**: For organization repository listing
3. **read:user**: For user information in PRs

### [Creating a Fine-Grained Token](#fine-grained-token)

Instead of using a classic token with broad permissions, use GitHub's fine-grained token:

1. Go to GitHub Settings > Developer Settings > Personal Access Tokens > Fine-grained tokens
2. Click "Generate new token"
3. Set a descriptive name and expiration
4. Select the organization
5. Configure repository access (typically "All repositories")
6. Set permissions:
   - Repository permissions:
     - Contents: Read
     - Pull requests: Read
   - Organization permissions:
     - Members: Read

### [Storing the Token Securely](#storing-token)

Store your token as a GitHub Actions secret:

1. Go to your repository settings
2. Navigate to Secrets and Variables > Actions
3. Create a new repository secret named `PR_REPORT_TOKEN`
4. Paste your token value

### [Token Rotation and Management](#token-management)

Best practices for token management:

1. **Set Expiry Dates**: Use short-lived tokens (e.g., 90 days)
2. **Implement Rotation**: Automate token rotation before expiry
3. **Limit Scope**: Use the most restrictive permissions possible
4. **Monitor Usage**: Review token usage regularly

## [Setting up the Required GitHub Actions Variables](#action-variables)

For the workflow to run properly, you'll need to set up these repository variables:

1. Go to your repository settings
2. Navigate to Secrets and Variables > Actions
3. Choose the "Variables" tab
4. Add the following variables:

| Name | Description | Example |
|------|-------------|---------|
| GITHUB_ORG | Your GitHub organization name | `your-organization` |
| PUBLISH_TO_PAGES | Whether to publish to GitHub Pages | `true` or `false` |
| SEND_EMAIL_REPORT | Whether to send email notifications | `true` or `false` |
| MAIL_SERVER | SMTP server address (if sending email) | `smtp.gmail.com` |
| MAIL_PORT | SMTP server port (if sending email) | `587` |
| MAIL_FROM | From email address (if sending email) | `reports@example.com` |
| REPORT_RECIPIENTS | Comma-separated list of recipients | `team@example.com` |

You'll also need these secrets if sending email:

- `MAIL_USERNAME`: SMTP username
- `MAIL_PASSWORD`: SMTP password

## [Extending the Reporting System](#extending)

The PR reporting system can be extended in several ways to provide additional insights.

### [Adding Repository-Level Statistics](#repo-statistics)

Extend the script to include repository-level statistics:

```python
def calculate_repo_stats(merged_prs):
    """Calculate repository-level statistics."""
    if not merged_prs:
        return {}
        
    total_additions = sum(pr['additions'] for pr in merged_prs)
    total_deletions = sum(pr['deletions'] for pr in merged_prs)
    
    # Calculate average time to merge
    merge_times = []
    for pr in merged_prs:
        if pr['merged_at'] and pr['created_at']:
            created_time = datetime.strptime(pr['created_at'], '%Y-%m-%dT%H:%M:%SZ')
            merged_time = datetime.strptime(pr['merged_at'], '%Y-%m-%dT%H:%M:%SZ')
            merge_times.append((merged_time - created_time).total_seconds())
    
    avg_merge_time = None
    if merge_times:
        avg_seconds = sum(merge_times) / len(merge_times)
        avg_merge_time = str(timedelta(seconds=avg_seconds))
    
    return {
        'pr_count': len(merged_prs),
        'total_additions': total_additions,
        'total_deletions': total_deletions,
        'avg_merge_time': avg_merge_time
    }
```

### [Adding Author Metrics](#author-metrics)

Track contributions by author:

```python
def calculate_author_metrics(merged_prs):
    """Calculate metrics per author."""
    authors = {}
    
    for pr in merged_prs:
        author = pr['user']['login']
        
        if author not in authors:
            authors[author] = {
                'pr_count': 0,
                'additions': 0,
                'deletions': 0,
                'repositories': set()
            }
            
        authors[author]['pr_count'] += 1
        authors[author]['additions'] += pr['additions']
        authors[author]['deletions'] += pr['deletions']
        authors[author]['repositories'].add(pr['base']['repo']['name'])
    
    # Convert sets to lists for serialization
    for author in authors:
        authors[author]['repositories'] = list(authors[author]['repositories'])
    
    return authors
```

### [Tracking Review Metrics](#review-metrics)

Add data about code reviews:

```python
def calculate_review_metrics(repositories, github_client):
    """Calculate review metrics across repositories."""
    reviewers = {}
    
    for repo in repositories:
        repo_name = repo['name']
        pull_requests = github_client.get_pull_requests(repo_name)
        
        for pr in pull_requests:
            reviews = github_client.get_pull_request_reviews(repo_name, pr['number'])
            
            if not reviews:
                continue
                
            for review in reviews:
                reviewer = review['user']['login']
                
                if reviewer not in reviewers:
                    reviewers[reviewer] = {
                        'review_count': 0,
                        'approved_count': 0,
                        'commented_count': 0,
                        'requested_changes_count': 0
                    }
                
                reviewers[reviewer]['review_count'] += 1
                
                if review['state'] == 'APPROVED':
                    reviewers[reviewer]['approved_count'] += 1
                elif review['state'] == 'COMMENTED':
                    reviewers[reviewer]['commented_count'] += 1
                elif review['state'] == 'CHANGES_REQUESTED':
                    reviewers[reviewer]['requested_changes_count'] += 1
    
    return reviewers
```

## [Visualizing the Data](#data-visualization)

Enhance reporting with data visualizations using simple JavaScript libraries.

### [Adding Charts with Chart.js](#adding-charts)

Incorporate Chart.js for visual metrics:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js"></script>
<script>
document.addEventListener('DOMContentLoaded', function() {
    // PR Size Distribution Chart
    const sizeLabels = ['XS', 'S', 'M', 'L', 'XL'];
    const sizeCounts = [
        document.querySelectorAll('.size-label:not([style*="display: none"])').length,
        // Count each size...
    ];
    
    const sizeCtx = document.getElementById('sizeChart').getContext('2d');
    new Chart(sizeCtx, {
        type: 'pie',
        data: {
            labels: sizeLabels,
            datasets: [{
                data: sizeCounts,
                backgroundColor: [
                    '#c0e0c0', '#b0d0b0', '#f0e0b0', '#f0c0a0', '#f0a0a0'
                ]
            }]
        },
        options: {
            responsive: true,
            plugins: {
                title: {
                    display: true,
                    text: 'PR Size Distribution'
                }
            }
        }
    });
    
    // Add more charts as needed
});
</script>
```

### [Interactive Filtering and Sorting](#interactive-filtering)

Add interactive data tables with sorting:

```html
<script src="https://cdn.jsdelivr.net/npm/simple-datatables@3.2.0/dist/umd/simple-datatables.min.js"></script>
<link href="https://cdn.jsdelivr.net/npm/simple-datatables@3.2.0/dist/style.min.css" rel="stylesheet">
<script>
document.addEventListener('DOMContentLoaded', function() {
    // Initialize all PR tables with sorting and filtering
    document.querySelectorAll('.pr-table').forEach(table => {
        new simpleDatatables.DataTable(table, {
            searchable: true,
            fixedHeight: false,
            perPage: 10
        });
    });
});
</script>
```

## [Advanced Usage: Custom Data Export](#data-export)

Add functionality to export data in different formats.

### [JSON Export](#json-export)

```python
def export_json_data(data, filename):
    """Export data as JSON for external analysis."""
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
```

### [CSV Export](#csv-export)

```python
import csv

def export_csv_data(merged_prs, filename):
    """Export PR data as CSV for spreadsheet analysis."""
    with open(filename, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        
        # Write header
        writer.writerow([
            'Repository', 'PR Number', 'Title', 'Author', 'Created At', 
            'Merged At', 'Time to Merge (hours)', 'Additions', 'Deletions',
            'Approver Count', 'Comment Count'
        ])
        
        # Write data
        for pr in merged_prs:
            repo_name = pr['base']['repo']['name']
            pr_number = pr['number']
            title = pr['title']
            author = pr['user']['login']
            created_at = pr['created_at']
            merged_at = pr['merged_at']
            
            # Calculate time to merge in hours
            time_to_merge = None
            if created_at and merged_at:
                created_time = datetime.strptime(created_at, '%Y-%m-%dT%H:%M:%SZ')
                merged_time = datetime.strptime(merged_at, '%Y-%m-%dT%H:%M:%SZ')
                time_to_merge = (merged_time - created_time).total_seconds() / 3600
            
            writer.writerow([
                repo_name,
                pr_number,
                title,
                author,
                created_at,
                merged_at,
                time_to_merge,
                pr['additions'],
                pr['deletions'],
                # Add other metrics...
            ])
```

## [Conclusion and Next Steps](#conclusion)

You now have a comprehensive GitHub PR reporting system that provides valuable insights into your development process. With the enhanced script and workflow, you can:

1. Track merged PRs across your entire organization
2. Generate rich, interactive HTML reports
3. Understand review patterns and code change metrics
4. Identify potential bottlenecks in your development process

### [Further Enhancements](#further-enhancements)

Consider these additional improvements for your PR reporting system:

1. **Integration with Slack or Microsoft Teams** for notifications
2. **Trend Analysis** comparing metrics over time
3. **Performance Impact** correlating PR sizes with build times
4. **Code Quality Metrics** integrating with tools like Sonar
5. **Custom Dashboards** for team-specific views

By leveraging these GitHub PR metrics, your team can make data-driven decisions to improve code review practices, identify bottlenecks, and enhance overall development efficiency.

## [Resources](#resources)

- [GitHub REST API Documentation](https://docs.github.com/en/rest)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Python Requests Library Documentation](https://requests.readthedocs.io/en/latest/)
- [Chart.js Documentation](https://www.chartjs.org/docs/latest/)
- [Simple DataTables Documentation](https://github.com/fiduswriter/Simple-DataTables)