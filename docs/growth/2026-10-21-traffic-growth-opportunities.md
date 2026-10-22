# support.tools Traffic Growth Opportunities (2026-10-21)

Research and plan only. Nothing here was posted, submitted, or changed outside this file. Social distribution through Buffer and the share cards is out of scope.

## Summary

**Revised 2026-10-21 (second revision) with Google Search Console data.** An earlier revision blamed a traffic decline on Google's August 2026 spam update. GSC shows that decline did not happen. Human search traffic is flat at about 150 clicks a week (4.8K clicks over 6 months). Comparing the 4 weeks before and after 2026-08-18, clicks rose 13% (554 to 625) and average position improved from 23.1 to 20.5. The apparent PostHog drop came from a bot. Over the last 30 days, one signature (Linux, Chrome 154, a viewport about 1905px wide) produced 3,893 pageviews, and 3,652 of them carried a `www.google.com` referrer. That is about 73% of all Google-referred pageviews, and it includes the 2 August and 20 September spike weeks.

The biggest lever is the search visibility the site already has. Over 6 months it earned 825K impressions at an average position of about 17 to 20 and a click-through rate of 0.6%. Most of those impressions are on page 2, or on page 1 with titles that do not earn the click. Doubling CTR on the highest-impression pages, or moving a few dozen page-2 pages onto page 1, would multiply clicks without writing a new post. The top earners are already climbing (`/curl-host-header/` from position 12 to 7.5, `/vmware-default-passwords-security-guide/` from 17.3 to 11.1, `/ping-mtu-linux/` from 15.6 to 11.7) and are close to the top 5.

Priorities, in order:
1. Rewrite titles and descriptions on high-impression, low-CTR pages.
2. Push page-2 pages onto page 1 with intent-matched refreshes and internal links.
3. Refresh the top earners.
4. Filter the bot out of PostHog.
5. Write more short exact-error answers from real incidents, and answer the matching Stack Exchange questions.

The scaled-content profile stays in the plan as risk reduction, not recovery. That profile is 130 near-duplicate slug clusters, 1,882 indexable tag pages, and a release queue running to 2032 at about 3,200 words per generic post. Duplicates also split impressions between competing URLs, which works against priority 2. Curator and community promotion comes last. Technical SEO at the page level is sound. The legacy `/post/<slug>/` URLs are healthy: each is the single live URL for its post, with a self-referencing canonical.

The original summary follows. Its analytics and decline statements are superseded by the paragraphs above.

support.tools is fast, well-structured, and technically sound at the page level: self-referencing canonicals, BlogPosting JSON-LD, Markdown alternates, llms.txt, a clean robots.txt, and a sitemap that correctly leaves out future-dated posts. Its growth limits are elsewhere. First, measurement is incomplete: the Universal Analytics tag (`UA-151436906-1`, `blog/themes/m10c/layouts/_default/baseof.html:62`) has recorded nothing since July 2023, but PostHog in the same template does work, and search data from Search Console is not being pulled yet. Second, the strongest content is buried. The original incident write-ups (Cilium MTU black hole, Longhorn rebuild retry ceiling, Cilium BPF "macro redefined", Cilium 1.19 VLAN upgrade) are scheduled behind a queue of 2,071 future-dated posts that runs into 2032, and three of the four are not due until 2027 or 2029. Third, the corpus has a scaled-content profile Google's spam policies target: 130 clusters of near-duplicate slugs covering 287 files (six separate CloudNativePG "production guides", five Gateway API guides), 1,882 indexable tag pages (63% of the sitemap), 1,245 of which hold exactly one published post, and a thin About page with no visible byline on posts. The site has never appeared on Hacker News, and the long-tail searches where it already ranks (exact error strings such as the Prometheus 64 GiB compaction failure, RKE2 certificate rotation) show what works.

## Traffic baseline

### Google Search Console (authoritative for search, provided 2026-10-21)

- **6 months:** 4.8K clicks, 825K impressions, CTR 0.6%, average position about 17. Roughly flat at about 150 clicks a week.
- **4 weeks before vs after 2026-08-18:**

| Metric | Before | After | Change |
|--------|-------:|------:|-------:|
| Clicks | 554 | 625 | +13% |
| Impressions | 132K | 111K | -16% |
| Avg position | 23.1 | 20.5 | improved |

- **Top pages gained position:** `/curl-host-header/` 12 to 7.5, `/vmware-default-passwords-security-guide/` 17.3 to 11.1, `/ping-mtu-linux/` 15.6 to 11.7.
- **Reading:** clicks up with fewer impressions and a better position means low-relevance impressions dropped away while the useful ones ranked higher. That is not what a sitewide demotion looks like. **Not verified:** which queries make up most of the 825K impressions. The page and query export in action 1 answers that.

### PostHog (use only with the bot excluded)

- **Bot signature:** Linux, Chrome 154, viewport about 1905px. Over the last 30 days it produced 3,893 pageviews, 3,652 of them with a `www.google.com` referrer (about 73% of Google-referred pageviews), including the 2 August and 20 September spike weeks.
- **Raw figures, invalid without the bot excluded:** weekly pageviews looked like about 3,500 in late July falling to about 1,300 in mid October. Over 30 days, sources showed Google 5,028, direct 2,084, Bing 308, internal 286, DuckDuckGo 170, Yandex 58, Reddit 12 and gemini.google.com 8. With the bot removed, human Google-referred pageviews are roughly 1,400 a month, which is consistent with GSC's roughly 600 clicks a month once multi-page visits are counted. Social is near zero either way.
- **Rule for every PostHog report:** exclude events matching that signature, for example with a cohort or filter on `$os = Linux`, `$browser = Chrome`, `$browser_version = 154` and `$viewport_width` between 1900 and 1910. Better still, drop them at capture time. Re-check the signature monthly, because bots rotate user agents. Use GSC, not PostHog, for any search trend.
- **Top pages (30-day PostHog pageviews, bot not yet excluded, so the order may be distorted).** GSC independently confirms the top three as the leading pages. Word counts are body words in the Markdown source.

| Page | Views | Published | Words | Type |
|------|------:|-----------|------:|------|
| `/` | 568 | | | home |
| `/vmware-default-passwords-security-guide/` | 150 | 2025-02-04 | 1,953 | reference answer |
| `/curl-host-header/` | 143 | 2024-11-25 | 414 | short how-to |
| `/ping-mtu-linux/` | 85 | 2024-10-22 | 678 | short how-to |
| `/training/` | 77 | | | hub |
| `/ollama-server-logs-guide/` | 75 | 2025-04-17 | 617 | short how-to |
| `/known-good-designs/` | 71 | | | hub |
| `/dell-idrac-racadm-installation-ubuntu-debian-2025/` | 49 | 2025 | | install how-to |
| `/post/wireshark-tcp-segment-reassembled-pdu-explanation/` | 48 | 2023-10-13 | 448 | explainer |
| `/usb-rs232-serial-converter-ubuntu-debian-guide-2025/` | 45 | 2025-10-05 | 2,350 | install how-to |
| `/post/online-resize-of-a-root-ext4-file-system/` | 39 | 2022-07-14 | 900 | short how-to |
| `/dfs-replication-storage-optimization-conflictanddeleted-cleanup-guide/` | 38 | 2026-06-11 | 1,696 | specific fix |
| `/migrating-rke1-to-rke2/` | 36 | 2025-03-12 | 2,404 | migration guide |
| `/required-domain-controller-ports/` | 33 | 2024-10-14 | 775 | reference answer |
| `/macos-keychain-docker-credential-user-interaction-not-allowed/` | 33 | 2026-09-19 | 3,669 | exact error string |
| `/build-install-openlens-linux/` | 33 | 2024-09-04 | 420 | short how-to |
| `/megacli-cheat-sheet/` | 32 | 2025-05-15 | 369 | cheat sheet |

### What the data says

1. **The visibility exists; the clicks do not.** 825K impressions at position 17 to 20 with 0.6% CTR is roughly 1,375 impressions per click. A page-1 result typically earns several times page-2 CTR, so position and title work on existing pages is the largest available lever. Lifting sitewide CTR from 0.6% to 1.2% would take clicks from about 150 to about 300 a week.
2. **Search value comes from long-tail answers.** Ten of the 14 top posts are under 1,000 words, and each answers a single narrow question. All three GSC-confirmed top pages are of this type. None of the roughly 300 long generic guides published in 2026 is among the top pages. They are not causing a decline, but they are not earning clicks either. **Unconfirmed:** the macOS keychain post (2026-09-19) appears in the PostHog list, but that may be bot-inflated, so confirm it in GSC.
3. **No decline, so the spam-update correlation is withdrawn.** Monthly publishing volume did rise sharply from March 2026 (27 to 44 posts a month, median about 3,200 words, mostly generic guide slugs, against a 400 to 700 word median in 2024), and Google ran spam updates in March, June and August 2026. GSC shows clicks and position improving across the August update. The scaled-content profile is a standing risk to manage, not the cause of a measured loss.
4. **The legacy `/post/` URLs are fine.** 229 of 2,911 post files have no `url:` frontmatter and are served at `/post/<slug>/`.
   - `/post/wireshark-tcp-segment-reassembled-pdu-explanation/` and `/post/online-resize-of-a-root-ext4-file-system/` return 200 with self-referencing canonicals; their root-level versions return 404.
   - Newer posts work the other way: `/curl-host-header/` returns 200 and `/post/curl-host-header/` returns 404.
   - There are no duplicate URLs. The risk is a future URL change made without a Hugo `aliases` entry; only one post uses `aliases` today.
5. **Category pages removed on 2026-10-20 now return 404.** Commit `2f953d21` ("content: normalize categories to canonical taxonomy", 692 files) dropped categories such as HTTP and cURL, so `/categories/http/` and `/categories/curl/` now 404. Any indexed or linked category URL should 301 to its new category.
6. **The hubs get visits.** The homepage, `/training/` and `/known-good-designs/` rank highly in PostHog (bot share unknown), and no post links to training or the reference designs.
7. **Bing and DuckDuckGo matter a little.** Together they send about 480 PostHog pageviews a month (bot share unknown; the bot used a Google referrer). DuckDuckGo results come largely from Bing's index.

## Top 15 actions (ranked)

Second re-ranking, after the GSC data. Earlier rankings are kept below for reference.

| # | Action | Why (evidence) | Expected impact | Effort | Owner action needed |
|---|--------|----------------|-----------------|--------|---------------------|
| 1 | Rewrite titles and meta descriptions for CTR on the highest-impression pages | 825K impressions, 0.6% CTR in 6 months. 417 of 799 published titles exceed 70 characters before the ` // Support Tools` suffix, so they truncate in results. 49 posts lack a description, 31 have one under 70 characters | Highest: doubling CTR on the top 50 impression pages roughly doubles clicks with no new content | 15 min per page | Export GSC Pages and Queries (6 months). For pages with over 2,000 impressions and CTR under 1%: put the dominant query in the first 50 to 60 characters of the title, write a description that states the answer, and drop "Comprehensive/Enterprise" filler. Re-check after 4 weeks |
| 2 | Move page-2 pages onto page 1 | Average position 17 to 20. The top pages are climbing (curl-host-header 7.5, ping-mtu 11.7, vmware-default-passwords 11.1) | High | 30 to 60 min per page | Filter GSC for pages at position 8 to 20 with high impressions. For each: answer the main query in the first paragraph, cover the related queries GSC shows as short sections, verify commands on current releases, update `lastmod`, and add 3 to 5 internal links from related posts using the query as anchor text |
| 3 | Refresh and protect the top earners | `/curl-host-header/`, `/vmware-default-passwords-security-guide/` and `/ping-mtu-linux/` sit at positions 7.5 to 11.7, a short step from the top 5. Two top URLs carry "2025" (iDRAC racadm, USB RS232) | High | 30 min per post | Keep URLs unchanged; update facts and versions; add a short FAQ for the secondary queries; add links to related answers |
| 4 | Filter the bot out of PostHog | One signature (Linux, Chrome 154, about 1905px viewport) made 3,893 of the last 30 days' pageviews, 73% of the Google-referred ones, and produced the false decline and both spike weeks | Critical for measurement; prevents wrong decisions | 30 min | Add an exclusion filter or a capture-time drop for the signature; build dashboards on the filtered view; use GSC for search trends |
| 5 | Internal links to the pages in actions 1 to 3, and to the hubs | Only 43 of 799 published posts contain an inline internal link; no post links to `/training/` or `/known-good-designs/` | Medium to high: the cheapest ranking help for page-2 pages | 10 min per link batch | Start with the 20 page-2 pages that have the most impressions |
| 6 | Write short exact-error and single-question posts from real incidents | This is the pattern of the top pages. An open example: searching "cloudnativepg switchover stuck old primary shutdown" returns only CNPG docs, Keycloak docs and oneuptime.com | High over 3 to 12 months | 1 to 3 h per post | 2 to 4 a month from incident notes; exact error string in the title; answer in the first paragraph |
| 7 | Answer specific Stack Exchange questions with complete answers | SO 71599858 (207k views), Ask Ubuntu 59458 (1.5M views), SO 73027461, Server Fault 1161473 and 1132557 (unanswered), SO 63184489 (unanswered); details in section 3 | Medium: referral visits from high-traffic questions (links are nofollow) | 30 min per answer | Write by hand, since SO bans AI-generated answers; disclose authorship |
| 8 | Consolidate near-duplicate posts and pause the generic queue (risk reduction) | 130 slug clusters (287 files), for example six CNPG guides; 2,071 posts queued to 2032. Duplicates split impressions and links between competing URLs, which holds pages on page 2 | Medium: protects against a future scaled-content demotion and concentrates ranking signals | About 2 h per 20 clusters | Merge unpublished duplicates first (no redirects needed); merge published pairs with `aliases` redirects; slow generic releases |
| 9 | Noindex thin tag pages and drop them from the sitemap (risk reduction) | 1,882 of 2,996 sitemap URLs are `/tags/`; 1,245 tags hold one post; all `index, follow` with today's lastmod | Medium: site-quality signal and crawl focus | 1 h | Approve a threshold (suggest under 5 posts) and a tag normalisation map |
| 10 | Build author and experience signals | No byline on posts; JSON-LD author is the homepage with no `sameAs`; the About page is four sentences; the Packt book and Master Classes are only on `/publications/` | Medium: E-E-A-T, and trust for the curator pitches | 2 h | Real About page, byline, author markup |
| 11 | Move first-hand incident posts forward in the queue | Longhorn `rebuildRetryCount` (dated 2027-04-10), Cilium "macro redefined" (2027-04-11), Cilium 1.19 VLAN incident (2027-06-28), Vault SSH CA (2029-01-14) | Medium: specific-error search answers plus link magnets | 15 min | One a week from 2026-11-01 |
| 12 | Set up Bing Webmaster Tools and IndexNow | Bing plus DuckDuckGo send about 480 PostHog views a month; DNS has the Bing `MS=` record | Low to medium | 30 min | Submit the sitemap; enable Cloudflare Crawler Hints |
| 13 | 301 the URLs that now 404 | Categories removed by `2f953d21`; `https://www.support.tools/` returns 404; missing pages return a zero-byte 404 body | Low to medium | 30 min | Cloudflare redirect rules; a real 404 page with search |
| 14 | Send the Cilium MTU write-up to curators (from 2026-10-25) and open the awesome-kubernetes PR | An original incident; SRE Weekly is active and favours incident retrospectives; awesome-kubernetes merges external entries | Low to medium: backlinks and authority, little direct traffic (Reddit sent 12 views in 30 days) | 1.5 h | SRE Weekly email, one HN submission, cilium.io and awesome-kubernetes PRs (section 6) |
| 15 | Hygiene: dead outbound links, link checker, dead UA tag | 5 of 38 sampled outbound links were dead; `baseof.html:62-67` still loads `UA-151436906-1` | Low | 1 h plus a CI job | Approve a lychee CI check; delete the UA block |

Lower priority, covered in the sections below: the KubeVirt blog post, the RSS author field and item cap, talks and podcasts, and dev.to or Hashnode cross-posts.

### First re-ranking (after PostHog data, superseded)

This ranking assumed a real traffic decline, which GSC disproved. It is kept only as history.

| # | Action | Why (evidence) | Expected impact | Effort | Owner action needed |
|---|--------|----------------|-----------------|--------|---------------------|
| 1 | Diagnose the decline in Google Search Console before making large changes | Weekly pageviews fell from about 3,500 to 1,300 between late July and mid October, starting near Google's 18 August 2026 spam update. GSC (DNS-verified) has the page and query clicks to tell a site-wide drop from a few lost pages | Critical: decides whether actions 2 to 4 are recovery or prevention | 1 h | Compare clicks for the 4 weeks before and after 18 August, by page and by query; check Pages indexing ("Crawled, currently not indexed") and Manual actions |
| 2 | Pause the generic long-form queue and consolidate near-duplicate clusters | Since March 2026 the site has published 39 to 44 posts a month, median about 3,200 words, mostly generic guide slugs, and none of them is a top page. There are 130 slug clusters (287 files), including six CNPG guides queued from 2026-12 to 2031-08 and four service mesh "comparison 2027/2028/2029/2030" posts. 2,071 posts are queued to 2032 | High: the likeliest contributor to a site-level quality demotion, and the cheapest to stop | 10 min to stop; about 2 h per 20 clusters to consolidate | Stop the daily generic releases; approve a merge list (unpublished duplicates first, which need no redirects) |
| 3 | Protect and refresh the posts that earn the traffic | Ten of the 14 top posts are short, single-question answers from 2022 to 2025 (curl Host header, ping MTU, MegaCLI, OpenLens, ext4 online resize). Two have "2025" in the URL (iDRAC racadm, USB RS232) | High: these pages carry most of the Google traffic | 30 min per post | Check commands on current Ubuntu and Debian, update facts and `lastmod`, keep the URLs, add 2 or 3 links to closely related answers |
| 4 | Noindex thin tag pages and drop them from the sitemap | 1,882 of 2,996 sitemap URLs are `/tags/`; 1,245 tags hold one published post; all are `index, follow` with today's lastmod | Medium to high: site-quality signal and crawl focus | 1 h (template change) | Approve a threshold (suggest noindex below 5 posts) and a tag normalisation map |
| 5 | Write short exact-error and single-question posts from real incidents | This is the top-page pattern, and it still works in 2026: `/macos-keychain-docker-credential-user-interaction-not-allowed/` (2026-09-19) reached the top 15 within a month. An open example: searching "cloudnativepg switchover stuck old primary shutdown" returns only CNPG docs, Keycloak docs and oneuptime.com | High over 3 to 12 months | 1 to 3 h per post | 2 to 4 a month from incident notes; exact error string in the title; answer in the first paragraph |
| 6 | Move first-hand incident posts forward in the queue | The Longhorn `rebuildRetryCount` post is dated 2027-04-10, Cilium "macro redefined" 2027-04-11, the Cilium 1.19 VLAN incident 2027-06-28 and the Vault SSH CA post 2029-01-14. Each names a specific failure | Medium to high: search answers plus the only link magnets | 15 min | One a week from 2026-11-01 |
| 7 | Answer specific Stack Exchange questions with complete answers | SO 71599858 (207k views), Ask Ubuntu 59458 (1.5M views), SO 73027461, Server Fault 1161473 and 1132557 (unanswered), SO 63184489 (unanswered); details in section 3 | Medium: steady referral visits from high-traffic questions (links are nofollow) | 30 min per answer | Write by hand, since SO bans AI-generated answers; disclose authorship |
| 8 | Build author and experience signals | No byline on posts; JSON-LD author is the homepage with no `sameAs`; the About page is four sentences; the Packt book and Rancher Master Classes appear only on `/publications/` | Medium to high: E-E-A-T matters most during a quality reassessment | 2 h | Write a real About page; add a byline and author markup |
| 9 | Add internal links: from the top pages to related answers, and from posts to the hubs | Only 43 of 799 published posts have an inline internal link. No post links to `/training/` or `/known-good-designs/`, yet those hubs get 77 and 71 views a month | Medium | 10 min per post | Start with the 17 top pages, then the RKE1 to RKE2 series |
| 10 | Set up Bing Webmaster Tools and IndexNow | Bing (308) and DuckDuckGo (170) send about 480 views a month, and DNS already has the Bing `MS=` record | Low to medium | 30 min | Submit the sitemap; enable Cloudflare Crawler Hints |
| 11 | 301 the URLs that now 404 | Categories removed by commit `2f953d21` (for example `/categories/http/`, `/categories/curl/`); `https://www.support.tools/` returns 404; missing pages return a zero-byte 404 body | Low to medium | 30 min | Cloudflare redirect rules; a real 404 page with search |
| 12 | Fix broken outbound links and add a link checker | 5 of 38 sampled outbound links were dead | Low to medium | 1 h plus a CI job | Approve a lychee CI check |
| 13 | Send the Cilium MTU write-up to curators on 2026-10-25 | An original incident with a reproducible fix; SRE Weekly is active and features incident retrospectives | Medium: backlinks and authority rather than direct traffic (Reddit sent 12 views in 30 days) | 1 h | SRE Weekly email, one HN submission, cilium.io PR (section 6) |
| 14 | awesome-kubernetes pull request (RKE2 the Hard Way plus the MTU post) | Active list that merges external entries; `/training/` is already a top-5 page | Low to medium: a durable, relevant backlink | 30 min | Open the PR from his own GitHub account |
| 15 | Remove the dead UA tag | `baseof.html:62-67` still loads `UA-151436906-1`; PostHog in the same template is the working analytics | Low: one fewer third-party script per page | 5 min | Delete the block |

### Original ranking (before the PostHog data)

| # | Action | Why (evidence) | Expected impact | Effort | Owner action needed |
|---|--------|----------------|-----------------|--------|---------------------|
| 1 | Remove the dead UA tag, add per-post topic properties to the working PostHog setup, and pull baselines from Google Search Console and Bing Webmaster Tools | (Corrected after review) PostHog project 78897 already records pageviews; the UA tag is dead weight. DNS carries `google-site-verification` and `MS=` records, so GSC and Bing are probably verified | Critical enabler: search data shows which queries and pages to work on | 30 min | Find the Google account that owns the GSC property; grant API access |
| 2 | Pull first-hand incident posts forward in the queue | The Cilium MTU post publishes 2026-10-25, but its sequel `longhorn-degraded-volumes-rebuild-retry-count-exhausted` is dated 2027-04-10, `cilium-bpf-macro-redefined-...` 2027-04-11, `cilium-1-19-vlan-subinterface-...` 2027-06-28, `vault-ssh-ca-console-only-root-...` 2029-01-14 | High: these are the only posts with link-magnet and HN potential, and two describe error strings with weak search results today | 15 min (frontmatter dates) | Decide new dates (suggest one per week from 2026-11-01) |
| 3 | Pause the generic long-form queue and consolidate near-duplicate clusters | 130 slug clusters, 287 files. Examples: 6 CNPG guides queued 2026-12 to 2031-08; 5 Gateway API guides; 4 service mesh "comparison 2027/2028/2029/2030" posts | High risk reduction (scaled content abuse policy); stops self-cannibalisation | Ongoing, about 2 h per 20 clusters | Approve a merge-and-redirect list; delete or merge the unpublished duplicates first (no redirects needed) |
| 4 | Noindex thin tag pages and remove them from the sitemap | 1,882 of 2,996 sitemap URLs are `/tags/`; 1,874 distinct tags across 799 published posts, 1,245 with one post; all tag pages carry `index, follow` and today's lastmod | Medium to high: crawl budget and site-quality signal | 1 h (template change) | Approve a threshold (suggest noindex below 5 posts) and a tag normalisation map (`postgres` vs `postgresql`) |
| 5 | Build author and experience signals | No byline in `.post-meta`; JSON-LD author URL points to the homepage, no `sameAs`; publisher logo is the per-post OG image; About page is four sentences and still mentions VMware. The owner has a Packt book (Rancher Deep Dive), a DZone Refcard, and Rancher Master Classes on `/publications/` that no post references | Medium to high for E-E-A-T and conversion of newsletter readers | 2 h | Write a real About page; provide headshot, role history, links |
| 6 | Launch the Cilium MTU write-up properly on 2026-10-25 | Original incident with numbers (45 volumes, 1,400 replica errors, 10 hours), reproducible bridge demo, and fix. SERPs for the topic show only generic oneuptime.com guides and a 2013 OpenStack thread | High: best single backlink and HN candidate on the site | 1 h | Send SRE Weekly email, submit to HN, PR to cilium.io (pitches below) |
| 7 | awesome-kubernetes pull request: RKE2 the Hard Way plus the Cilium MTU post | Repo active (pushed 2026-10-21, 16.1k stars), merges external entries; `docs/learning-resources/courses.md` has a Tutorials section, `docs/articles/articles.md` has a Networking section | Medium: durable, relevant backlink | 30 min | Open the PR from his own GitHub account |
| 8 | Add inline internal links from posts to posts, training and reference designs | Only 43 of 799 published posts contain an inline internal link; zero posts link to `/known-good-designs/` or `/training/rke2-hard-way/` | Medium: spreads authority to the 12-part RKE2 Hard Way series and reference designs | Ongoing, 10 min per post | Prioritise the 20 posts with most GSC impressions |
| 9 | Answer specific Stack Exchange questions with complete answers | SO 71599858 (207k views, Helm "another operation is in progress"), Ask Ubuntu 59458 (1.5M views, sudo unable to resolve host), SO 73027461 (inotify limit), Server Fault 1161473 and 1132557 (unanswered Longhorn), SO 63184489 (unanswered NodeLocal DNS CrashLoopBackOff) | Low to medium links (nofollow), steady referral traffic, reputation | 30 min per answer | Write by hand; SO prohibits AI-generated answers and requires affiliation disclosure |
| 10 | Fix broken outbound links and add a link checker | 5 of 38 sampled outbound links were dead (Harvester v1.2 docs x3, Longhorn 1.4.3 docs, rancher.com k3s docs). Also only about one outbound citation per post in the sample | Low to medium quality signal | 1 h plus CI job | Approve a CI link check (lychee) |
| 11 | Pitch an original post to the KubeVirt blog | kubevirt.github.io merged a community blog post 2026-09-18; the MTU story is a KubeVirt networking lesson | Medium: project-domain backlink and audience | 3 h writing | Write a shorter original piece that links to the full write-up |
| 12 | Redirect `www.support.tools` to the apex and serve a real 404 page | `https://www.support.tools/` returns 404 publicly; missing pages return 404 with a zero-byte body | Low to medium: recovers stray links and keeps 404 visitors | 20 min | Cloudflare redirect rule; Hugo 404 template served by the Go server |
| 13 | Fix RSS: add author, cap item count | `index.xml` is 3.1 MB with 920 items and no `<author>`/`dc:creator`; Planet PostgreSQL requires feeds to identify the author by name | Low now, enables Planet PostgreSQL and aggregator pickup later | 30 min | Approve change to the RSS template |
| 14 | Turn private incident notes into exact-error-message posts | Owner has hundreds of incident notes (CNPG switchover stalls, Longhorn stuck detaching, RKE2 cert expiry). Example SERP: "cloudnativepg switchover stuck old primary shutdown" shows CNPG docs, Keycloak docs and oneuptime.com only | High over 6 to 12 months | 3 to 5 h per post | Pick 2 per month; strip customer-identifying details |
| 15 | Talks and podcasts | KubeCon EU 2027 (Barcelona, 15 to 18 March) CFP closed 2026-10-11. Kubernetes Podcast from Google is active in 2026. DevOpsDays Chicago 2027 and SREcon27 CFPs not yet found | Medium, slow: authority and links from event pages | Varies | Watch for KubeCon NA 2027 and DevOpsDays Chicago CFPs; draft one talk from the MTU incident |

## 1. Technical SEO of the live site

All checks were run on 2026-10-21 (site clock already 2026-10-22 UTC) with `curl` against `https://support.tools`.

### What is already good

- **robots.txt**: `User-agent: * / Allow: /` plus the sitemap line. Nothing blocked.
- **Canonicals**: posts self-canonicalise (`<link rel=canonical href=https://support.tools/pod-security-standards-implementation-enterprise-guide/>`). Tag pages self-canonicalise too.
- **Structured data**: one `BlogPosting` JSON-LD block per post with headline, description, image, datePublished, dateModified, keywords, wordCount, `isPartOf` WebSite.
- **Social meta**: full Open Graph and `summary_large_image` Twitter cards with the per-post share image.
- **Markdown and LLM output**: every post has `rel=alternate type=text/markdown` at `index.md` (verified 200, 29.6 KB vs 167 KB HTML), and `/llms.txt` (20.7 KB) lists navigation and recent articles. Responses carry `content-signal: ai-train=no, search=yes, ai-input=yes`.
- **Future posts stay hidden**: `https://support.tools/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/` (dated 2026-10-25) returns 404 and is not in the sitemap. The theme fixture posts (`draft: true`, `noindex: true`) return 404.
- **Weight**: post HTML is 17.6 KB gzipped, CSS 4.8 KB, JS 1.3 KB. The cover image has `width`, `height`, `fetchpriority=high`; fonts are self-hosted through Cloudflare with `font-display:swap`. **Not verified**: Core Web Vitals field data. The PageSpeed Insights API returned a daily quota error, so check the GSC Core Web Vitals report (CrUX) instead.
- **HTTP to HTTPS**: `http://support.tools/` 301s to HTTPS.
- **Related guides**: posts render a `related-guides` section (tag and category weighted, `blog/config.toml` `[related]`).

### Problems, ranked by impact

1. **Dead UA tag; PostHog is the working analytics.** `blog/themes/m10c/layouts/_default/baseof.html:62` loads `gtag/js?id=UA-151436906-1`, which has processed nothing since 1 July 2023. (Correction added after review: the PostHog snippet in the same file works; project 78897 has the data.) `memory-bank/projectRoadmap.md:24` still lists "Implement website analytics" as open. GSC (DNS TXT `google-site-verification=_Q7uz...`) and Bing (`MS=ms97664494`) appear verified, which is where search data lives today.
2. **Taxonomy bloat.** The sitemap has 2,996 URLs: 1,882 `/tags/`, 176 `/categories/`, 20 reference designs, 80 training pages, and about 840 posts and other pages. Across the 799 published posts there are 1,874 distinct tags; 1,245 are used once and 1,502 at most twice. Every tag page is `index, follow` and stamped with today's lastmod, so Google sees roughly 1,900 near-empty list pages that change daily. Case and synonym variants split topics (`/tags/postgresql/` 8 items, `/tags/postgres/` 2, `/tags/cnpg/` 1).
3. **Near-duplicate posts (cannibalisation and scaled-content signal).** A slug-similarity pass over `blog/content/post/` found 130 clusters, 287 files. Examples:
   - `kubernetes-gateway-api-production-guide-advanced.md` (2028-05-14), `...-advanced-production-guide.md` (2027-12-06), `...-production-guide.md` (2027-10-23), `...-advanced-guide.md` (2027-08-07), `...-implementation-guide.md` (2027-05-06)
   - `cloudnativepg-postgresql-operator-kubernetes-production-guide.md` (2026-12-21), `cloudnativepg-postgresql-kubernetes-production-guide.md` (2027-03-23), `cloudnativepg-postgresql-kubernetes-guide.md` (2027-06-24), `cloudnativepg-cnpg-production-operations-guide.md` (2027-10-05), `cloudnativepg-postgresql-kubernetes-operator-guide.md` (2028-09-15), `cloudnativepg-postgresql-ha-failover-backups-kubernetes-guide.md` (2031-08-20)
   - `kubernetes-service-mesh-comparison-2027-guide.md`, `-2028.md`, `-2029.md`, `-2030-guide.md`
   - `go-grpc-gateway-rest-grpc-transcoding-guide-guide.md` (a doubled word in the slug)
   - Already published: `cilium-troubleshooting.md` (2024-03-27) and `cilium-troubleshooting-2025.md` (2025-03-14); `incident-communication-strategies-enterprise-guide` and `incident-communication-strategies-production-guide` published one day apart (2026-08-06, 2026-08-07).
   Also, 1,223 of 2,870 filenames contain "guide", "comprehensive", "complete" or "enterprise".
4. **The release queue runs to 2032.** Post dates by year: 2026: 406, 2027: 411, 2028: 366, 2029: 366, 2030: 361, 2031: 364, 2032: 110. Content written in 2026 about current versions will be four to six years stale when it appears, and twelve titles already contain years 2027 or later. A post titled "2030 guide" written in 2026 is a quality liability.
5. **Weak author signals.** The post meta line shows date, read time and category, but no author. JSON-LD has `"author":{"@type":"Person","name":"Matthew Mattox","url":"https://support.tools/"}` with no `sameAs`, and `publisher.logo` is the per-post share image rather than a site logo. `/about/` says "Rancher/Kubernetes Principal Support Engineer" and "Rancher, Kubernetes, Docker, VMware" in four sentences. `/publications/` lists the Packt book *Rancher Deep Dive*, a DZone Refcard, and five Rancher Kubernetes Master Class videos, which is strong evidence of expertise that no article surfaces.
6. **Thin internal linking.** 43 of 799 published posts contain an inline link to another support.tools page. `grep -rl known-good-designs blog/content/post` returns 0 files; `grep -rl rke2-hard-way blog/content/post` returns 0. The 12-part *RKE2 the Hard Way* series (12,345 words) and the 18 reference design pages get links only from menus.
7. **Pagination canonicals.** `https://support.tools/archive/page/2/` declares `canonical=https://support.tools/archive/`. Google's guidance is that paginated pages should self-canonicalise; pointing them at page 1 tells Google to ignore the deeper pages that are the only crawl path (other than the sitemap) to older posts. `/post/` is also a separate indexable list page alongside `/archive/`.
8. **Titles and descriptions.** Of 799 published posts, 417 have titles over 70 characters before the ` // Support Tools` suffix (example: "Pod Security Standards Implementation Guide: Enforcing Container Security in Kubernetes Enterprise Environments"). 49 have no description and 31 have one under 70 characters. Fix titles where GSC shows impressions but low CTR, not in bulk.
9. **Broken outbound links.** In a sample of 40 published posts (38 real outbound links), these were dead: `docs.harvesterhci.io/v1.2/...` (three anchors, 404) in `harvester-troubleshooting.md`, `longhorn.io/docs/1.4.3/troubleshoot/` (404) in the same post, `rancher.com/docs/k3s/latest/en/advanced/#troubleshooting-dns` (502) in `resolving-pod-dns-problems-in-k3s-with-coredns.md`. That is about 13% dead in a small sample, concentrated in older Rancher-stack posts. The sample also shows posts cite few primary sources (about one outbound link per post).
10. **www and 404.** `https://www.support.tools/` resolves publicly to Cloudflare and returns 404 rather than a redirect. Missing pages return a 404 with `content-length: 0`, so a visitor from a stale link sees a blank page with no search box. (Local split-horizon DNS resolves `www` to 172.28.58.8; only public behaviour matters here.)
11. **RSS.** `/index.xml` is 3.1 MB with 920 items and no author element. Large feeds are slow for readers and aggregators; Planet PostgreSQL requires "All blogs should be identified by the posters name" (https://www.postgresql.org/about/policies/planet-postgresql/).
12. **Minor.** Cover image `alt` is empty on posts; the 09:00 publish time and the 09:10 Chicago rebuild are fine for indexing.

### Fix list for the template layer

- Delete the dead UA block at `baseof.html:62-67`; PostHog in the same template is the working analytics.
- Never change a published URL without a Hugo `aliases` entry. This matters most for the 229 posts served at `/post/<slug>/`, which include top pages such as `/post/wireshark-tcp-segment-reassembled-pdu-explanation/`.
- In the taxonomy template: `noindex, follow` when `len .Pages < 5`; exclude those terms from `sitemap.xml`. Normalise tags with a mapping pass before publishing.
- Paginated list pages: self-referencing canonical.
- Post template: visible "By Matthew Mattox" linking to `/about/`; JSON-LD author `url: https://support.tools/about/`, `sameAs` GitHub, LinkedIn, Bluesky, the Packt book page; `publisher.logo` set to `https://support.tools/images/logo.png`.
- RSS template: `<author>` or `dc:creator`, and `services.rss.limit = 50`.
- Cloudflare: redirect rule `www.support.tools/*` to `https://support.tools/$1` (301). Consider Crawler Hints (IndexNow) for Bing.
- CI: `lychee` link check on changed posts. Build-path tier: run it from a binary baked into the runner image or from the Harbor mirror, not a live download.

## 2. Backlink opportunities (verified)

| Target | Status (verified 2026-10-21) | Fit and support.tools URL | How to submit | Effort |
|--------|------------------------------|---------------------------|---------------|--------|
| SRE Weekly (https://sreweekly.com/) | Active: issue #539, 2026-10-18 | Incident retrospectives are a genre the editor highlights. `https://support.tools/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/` (live from 2026-10-25), then the Longhorn retry-count sequel | Reply to an issue or email the editor (first name at sreweekly.com, per https://sreweekly.com/about-sre-weekly-2/). The editor states he leaves agent-written submissions unread, so the owner must write and send it personally; no embargoed content | 10 min |
| awesome-kubernetes (https://github.com/ramitsurana/awesome-kubernetes) | Active: pushed 2026-10-21, 16.1k stars, recent external entries merged | `docs/learning-resources/courses.md`, section "Tutorials": `https://support.tools/training/rke2-hard-way/`. `docs/articles/articles.md`, section "Networking": the Cilium MTU post | Pull request | 30 min |
| cilium.io blog, external links (https://github.com/cilium/cilium.io) | Active; CONTRIBUTING.md says the blog "includes original blog posts about Cilium, as well as links to external articles hosted elsewhere"; external posts get the External tag via `externalUrl` frontmatter. External-post PRs merged 2025-10-13 and 2026-02-24 (mostly by Isovalent staff, so acceptance of independent authors is likely but not proven) | The Cilium MTU post; later the Cilium 1.19 VLAN upgrade incident and the BPF "macro redefined" post | PR adding a post with `externalUrl` and `ogImageUrl`, optionally discussed first in `#cilium-website` on Cilium Slack | 45 min |
| KubeVirt blog (https://github.com/kubevirt/kubevirt.github.io) | Active: community post merged 2026-09-18 (`2026-09-03-understanding-kubevirt-host-kernel-userspace-dependencies.md`) | An original short post: "KubeVirt VMs on a Linux bridge can shrink your CNI's MTU" linking to the full write-up | PR to `_posts/`, commits signed off (`git commit -s`) | 3 h |
| Learn Kubernetes Weekly (https://learnkubernetesweekly.substack.com) | Active: latest issue 15 Oct 2026, editor Daniele Polencic (LearnKube) | Cilium MTU post, RKE2 the Hard Way | **Not verified**: no published submission route. Replying to an issue email (Substack replies reach the author) is the likely path | 10 min |
| Postgres Weekly (https://postgresweekly.com/) | Active: issue #670, 2026-10-21; the issue says "Reply and tell us. We can't include everything but we'll look at anything you send." | Weak today: no first-hand CNPG post is published. Hold for a CNPG incident post (action 14) | Reply to an issue email | 10 min later |
| Golang Weekly (https://golangweekly.com/) | Active: issue #620, 2026-10-09; same publisher (Cooperpress) as Postgres Weekly | Weak: published Go posts are generic. Only pitch an original Go piece | Reply to an issue email (same Cooperpress practice; not stated on the Golang page) | n/a |
| DevOps'ish (https://buttondown.com/devopsish/archive/) | Active: issue 331, 2026-10-18 | Cilium MTU post | **Not verified**: no submission route published; editor reachable via linked social profiles | 10 min |
| awesome-k8s-security (https://github.com/magnologan/awesome-k8s-security) | Active: articles merged 2026-07-31; has "Blogs and Articles" | Only if a genuinely original security post exists. The published security posts are generic guides, so skip for now | PR | n/a |
| Planet PostgreSQL (https://planet.postgresql.org/) | Active; policy updated 2025-10-02; requires a Postgres-only category feed and author names | `https://support.tools/tags/postgresql/index.xml` once it has original posts and an author field | postgresql.org community account, add feed | 20 min later |
| danluu/post-mortems (https://github.com/danluu/post-mortems) | Active: commits 2026-08-31, but entries are almost entirely company postmortems added by the maintainer | Cilium MTU post is a stretch (no company named) | PR; low acceptance odds | 15 min |
| kubernetes.io blog | Active; accepts only original, unpublished, vendor-neutral content; pitch in `#sig-docs-blog` Slack (https://kubernetes.io/docs/contribute/blog/article-submission/) | A vendor-neutral piece on "Pod MTU is fixed at creation; node MTU is not", using the incident as illustration | Pitch, then PR with CLA | 6 h |

**Not worth pursuing, with reasons:**
- **KubeWeekly** (CNCF): the archive stops at #434 (2025-05-30), titled "This isn't goodbye...". CNCF folded its newsletters into a monthly newsletter and pointed suggestions to marketing@cncf.io. **Not verified** whether the monthly accepts external blog links.
- **Last Week in Kubernetes Development** (lwkd.info): covers upstream Kubernetes development only; blog posts are out of scope.
- **TLDR DevOps** (https://tldr.tech/devops): active (sends Monday, Wednesday, Friday) but publishes no reader submission route; only advertising.
- **DevOps Weekly** (devopsweekly.com): the homepage shows no dates and the archive URL returns 404. **Not verified** as active in 2026.
- **hjacobs/kubernetes-failure-stories (k8s.af)**: archived since 2020.
- **awesome-postgres** (https://github.com/dhamaniasad/awesome-postgres): active, but its "Blogs" section lists Postgres-focused blogs; support.tools does not qualify.
- **CloudNativePG blog** (https://cloudnative-pg.io/blog): no community submission process found; posts are by maintainers.
- **CNCF blog**: guidelines (https://github.com/cncf/foundation/blob/main/blog-guidelines.md) limit it to members, project maintainers, TAGs and ambassadors.

### Conferences and podcasts

- **KubeCon + CloudNativeCon Europe 2027**, Barcelona, 15 to 18 March 2027: CFP closed 2026-10-11 (https://events.linuxfoundation.org/kubecon-cloudnativecon-europe/program/cfp/). Next window: KubeCon NA 2027, usually opening early in the year.
- **DevOpsDays Chicago**: the 2025 CFP ran 2024-08-05 to 2024-10-20 (https://talks.devopsdays.org/devopsdays-chicago-2025/cfp). **Not verified**: a 2027 CFP. The owner lives near Chicago, so this is the cheapest stage to test the MTU talk.
- **SREcon27 Americas**: **not verified**; past CFPs closed in November for March events (https://www.usenix.org/srecon).
- **Kubernetes Podcast from Google**: active with external practitioner guests in 2026 (Uber, Lovable). A Rancher support veteran with an incident story is a plausible guest; pitch through the show's contact after two or three incident posts are live.

## 3. Communities and syndication

### Hacker News and Lobsters

- `hn.algolia.com` shows zero stories ever submitted from support.tools. Comparable topics are rare on HN (search "kubernetes mtu black hole": 0 stories), so a good write-up has little competition.
- **HN candidates** (original, specific, mechanism-level): the Cilium MTU black hole post; the Longhorn `rebuildRetryCount` ceiling post; the Prometheus 64 GiB index ceiling post (`/prometheus-tsdb-compaction-failed-index-64gib-cardinality/`, already ranks first for its error string); the OpenZFS block cloning post (`/openzfs-block-cloning-brt-internals-corruption-incident-safe-rollout/`, history plus internals, but not first-hand). Submit once, on a weekday morning US time, with the post's own title; do not ask anyone to upvote.
- **Lobsters** (https://lobste.rs/about): invite-only; self-promotion "should be less than a quarter of one's stories and comments in the last year", and new users cannot submit self-promotion during their first 70 days. Only worth it if the owner participates for months first.
- **Do not submit**: generic "enterprise guide" posts. The `kubernetes-pod-startup-failures-too-many-services-incident` post opens "At 3:47 AM on a Tuesday morning, our production monitoring system lit up" and reads as a composite narrative; if it is not a real incident, HN readers will notice and it damages credibility for the real ones. Review every post that claims "our production" (list in section 4).

### Reddit

Reddit blocked both the JSON API and WebFetch from this environment, so **subreddit rules were not verified directly**. What secondary sources show:
- r/homelab (mirror dated June 2026): self-promotion rule narrowed to monetised or commercial links; AI use must be disclosed in flair and post text.
- r/selfhosted (wiki mirror): blog posts allowed but not as bare links; context required; shilling banned.
- r/devops: a moderator proposal to ban low-effort AI-generated posts was reported (opinion piece, unverified).
- r/kubernetes, r/sysadmin, r/golang, r/PostgreSQL: **not verified**. Read each sidebar before posting.

Practical approach: post only first-hand incident write-ups, as a text post with a real summary of the failure and the fix in the body and the link at the end, from the existing `u/cube8021` account, and stay in the comments. Best fits: r/kubernetes (Cilium MTU, Longhorn retry count), r/homelab and r/selfhosted (KubeVirt plus Linux bridge MTU, ZFS block cloning), r/PostgreSQL (future CNPG incidents), r/golang (only original Go work). No more than one support.tools link per subreddit per month.

### Cross-posting with canonical URLs

- **dev.to**: supports `canonical_url` in frontmatter. Its AI-assisted article guidelines (https://dev.to/guidelines-for-ai-assisted-articles-on-dev) require disclosing AI involvement and forbid posts whose main purpose is backlinks, though a backlink to a personal blog is allowed. Cross-post only first-hand posts, set `canonical_url` to the support.tools URL, and add the disclosure if AI drafting was involved.
- **Hashnode**: supports "originally published at" canonical. **Medium**: its Import tool sets the canonical; links are nofollow, so the value is readers, not ranking.
- Wait 3 to 7 days after publication so Google indexes the original first. Limit to 1 or 2 posts a month.

### Stack Overflow, Server Fault, Ask Ubuntu

Real questions a published post answers (Stack Exchange API, sorted by votes):

| Question | Views | State | support.tools post |
|----------|-------|-------|--------------------|
| https://stackoverflow.com/questions/71599858 "UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress" | 207,158 | answered, no accepted answer | `https://support.tools/helm-stuck-release-fix/` |
| https://askubuntu.com/questions/59458 "sudo: unable to resolve host (none)" | 1,525,354 | accepted | `https://support.tools/post/how-to-fix-sudo-unable-to-resolve-host-error-ubuntu/` (only add an answer if it covers a case the existing answers miss) |
| https://stackoverflow.com/questions/73027461 "OSError: [Errno 28] inotify watch limit reached" | 26,979 | answered | `https://support.tools/linux-inotify-limits-directory-watch-allocation-failures-guide/` |
| https://serverfault.com/questions/1161473 "Longhorn distributed block storage not working with Flannel CNI" | 1,870 | unanswered | `https://support.tools/post/fixing-longhorn-volume-issues/` |
| https://serverfault.com/questions/1132557 "Failed pvc attachment using kubernetes longhorn" | 1,448 | unanswered | `https://support.tools/post/fixing-longhorn-volume-issues/` |
| https://stackoverflow.com/questions/63184489 "nodelocaldns pod status is CrashLoopBackOff" | 1,465 | unanswered | `https://support.tools/coredns-nodelocaldns-troubleshooting-monitoring/` |
| https://serverfault.com/questions/1189886 "Harvester failing to connect to Rancher due to TLS certificate signed by unknown authority" | 510 | accepted | `https://support.tools/post/harvester-troubleshooting/` (fix its dead doc links first) |

Rules that matter: answers must stand on their own (link-only answers are deleted), the author must disclose that he wrote the linked post, and Stack Overflow bans AI-generated answers. Write these by hand.

## 4. Content and keyword strategy

### Where the site wins today

- **PostHog and GSC agree (added after review; PostHog counts include a bot, see Traffic baseline).** The 30-day top pages are short, single-question answers. Examples: setting the Host header with curl, ping MTU testing, a MegaCLI cheat sheet, building OpenLens, online ext4 resize, required domain controller ports, VMware default passwords, Ollama server logs, and installing iDRAC racadm. The 2026 additions that rank are also narrow fixes, such as the DFS Replication ConflictAndDeleted cleanup and the macOS keychain Docker credential error. Shift the content mix toward these:
  - One question per post.
  - The exact command or error string in the title and the first paragraph.
  - 400 to 1,500 words.
  - Commands verified on current releases.

  Deep incident write-ups are the second pillar, aimed at backlinks. Generic 3,000-word "enterprise guides" are not earning traffic in this data and should stop being the default output.

- Exact error strings with few good answers. Web search for `prometheus "compaction failed" index exceeds 64GiB` returns the support.tools post first, ahead of Grafana's 2019 blog and GitLab's issue tracker. `rke2 rotate certificates expired` returns `https://support.tools/post/rotate-rke2-certs/` second, between oneuptime.com posts. Both are narrow, high-intent troubleshooting queries.
- Rancher-stack depth: published RKE2 (63 posts tagged), Rancher (55), Longhorn (24), plus the RKE1 to RKE2 migration series (7 posts, 2025-03). RKE1 reached end of life on 2025-07-31, so the migration series has a live audience; it should be the first internal-linking hub.

### Who the site competes with

- oneuptime.com is publishing mass-produced guides on exactly this stack in 2026 (examples returned by search: "How to Rotate RKE2 Certificates", "How to Debug Longhorn Replica Rebuilding Issues", "Troubleshoot Cilium Fragment Handling", "CloudNativePG Replica Promotion Fails"). Generic how-to posts from support.tools are competing with that volume and with official docs. Original incident analysis is the one thing those sites cannot produce.
- Example gaps where search shows only generic or official material: Linux bridge MTU following its smallest port under Cilium plus KubeVirt (only oneuptime.com and a 2013 OpenStack thread); Longhorn degraded volumes with no rebuild in progress after `rebuildRetryCount` hits 5 (no answer surfaced, SUSE forum thread about a 99% rebuild only); CNPG switchover waiting on old primary shutdown (`switchoverDelay` defaults to more than a year; only docs and oneuptime.com).

### Best link magnets in the corpus

1. Cilium MTU black hole (publishes 2026-10-25).
2. Longhorn `rebuildRetryCount` exhausted (sequel; move from 2027-04-10 to about 2026-11-01).
3. Cilium "macro redefined" BPF compile failure caused by NetworkManager disabling IPv6 on `cilium_host` (move from 2027-04-11).
4. Cilium 1.19 upgrade incident, VLAN sub-interface node IPs and pinned bpffs links (move from 2027-06-28).
5. Prometheus 64 GiB index ceiling (published 2026-07-21).
6. RKE2 the Hard Way, 12 parts (`/training/rke2-hard-way/`).
7. RKE1 to RKE2 migration series (7 posts).
8. `when-rancher-upgrades-go-sideways` and `rke2-with-rancher-disaster-recovery` (older, first-person, support-engineer perspective).

### Scaled-content risk assessment

Google's spam policies define scaled content abuse as many pages generated mainly to manipulate rankings with little value, "whether automation, humans or a combination are involved" (https://developers.google.com/search/docs/essentials/spam-policies#scaled-content). There is no published volume threshold. Google ran spam updates in March, June and August 2026 (secondary sources: gsqi.com case studies, relevantaudience.com); recovery from an algorithmic demotion takes months and has no reconsideration request.

Risk factors present here:
- Volume and cadence: 2,870 posts, 2,071 future-dated, roughly one per day for six years.
- Templated titles and slugs: 1,223 filenames with guide/comprehensive/complete/enterprise; dozens of 3 to 6 post clusters on one topic.
- Narratives that may be invented ("At 3:47 AM on a Tuesday...").
- Year-stamped titles that do not match publication dates.
- Thin author identity on the page, generic About page.

Mitigating factors: real expertise (book, Master Classes, years in Rancher support), genuinely original incident posts, accurate technical depth in sampled posts, no ads or affiliate links.

What to do, in order:
1. **Unpublished queue first (cheap, no redirects).** For each near-duplicate cluster keep the strongest file, merge unique sections into it, delete the rest. Target: cut the 2,071-post queue by at least a third before 2027. Remove year numbers from titles unless the post is about that release.
2. **Published duplicates.** Merge `cilium-troubleshooting.md` into `cilium-troubleshooting-2025.md`, `incident-communication-strategies-production-guide` into the enterprise one, and similar pairs; add Hugo `aliases` so the old URL 301s.
3. **Noindex, do not delete, weak published posts.** Once GSC data exists, mark posts with zero impressions over 6 months and no unique value as `noindex` (or merge). Reassess quarterly.
4. **Audit "our production" claims.** Posts with first-person incident language include `kubernetes-pod-startup-failures-too-many-services-incident`, `traefik-production-incidents-configuration-management-recovery`, `chaos-testing-message-queues-in-go`, `service-mesh-istio-production-implementation-monitoring`. Keep the claim only where it happened; otherwise reframe as "a scenario" or rewrite.
5. **Author signals.** Visible byline, About page with role history, the Packt book, Master Classes, certifications, GitHub; a short "How this site is written" note that is honest about AI-assisted drafting and states that incident posts are first-hand. This also matters for SRE Weekly, dev.to and Reddit, which all now screen for AI-written material.
6. **Slow the cadence of generic posts** and spend the time on two first-hand posts a month.

## 5. Quick wins vs. ongoing programs

### Doable in an hour

1. Delete the dead UA tag (`baseof.html:62-67`). PostHog already records pageviews. In PostHog, exclude the bot signature (Linux, Chrome 154, viewport about 1905px).
2. Open GSC: export Pages and Queries (6 months) sorted by impressions, mark pages with CTR under 1% or position 8 to 20 for actions 1 and 2, and rewrite the first five titles and descriptions; also export Performance (16 months), check Pages indexing (how many tag pages are indexed, any "Crawled, currently not indexed" spikes), Core Web Vitals, and Manual actions.
3. Change the dates of the four first-hand posts so they publish weekly from 2026-11-01.
4. Cloudflare 301 rule for `www`.
5. On 2026-10-25: email SRE Weekly about the Cilium MTU post, submit it to HN.
6. Open the awesome-kubernetes PR (two entries).

### Ongoing programs

- **Weekly**: one curator pitch per new first-hand post (SRE Weekly, Learn Kubernetes Weekly, cilium.io or KubeVirt as relevant); one Stack Exchange answer.
- **Monthly**: two incident write-ups from the owner's notes in the "exact error string, mechanism, reproduction, fix" format; consolidate 20 near-duplicate clusters; one Reddit text post in the matching subreddit; one dev.to or Hashnode canonical cross-post.
- **Quarterly**: GSC review to prune or noindex dead-weight posts and rewrite titles with impressions but low CTR; link-check report; talk submission when a CFP opens (KubeCon NA 2027, DevOpsDays Chicago).

## 6. Ready-to-adapt pitch text

The owner should rewrite these in his own voice and send them himself. SRE Weekly in particular ignores agent-written submissions. All URLs below must be live before sending (the Cilium post goes live 2026-10-25).

### 6.1 SRE Weekly (reply to the latest issue, or email the editor at his first name at sreweekly.com)

> Subject: Incident write-up: Cilium MTU silently tracking a Linux bridge
>
> Hi Lex,
>
> I run production RKE2 clusters with KubeVirt and Longhorn, and wrote up an incident that might fit SRE Weekly: about 45 Longhorn volumes stayed degraded for ten hours while every health check was green. The cause was three ordinary behaviors stacked together: a Linux bridge takes the MTU of its smallest port, KubeVirt VMs attach 1500-byte veths to that bridge, and Cilium without a configured MTU keeps following the device MTU at runtime while existing pods keep the old value. Large VXLAN packets were dropped with no error anywhere.
>
> The post covers detection, a reproducible demo of the bridge behavior, and the planned full-cluster outage we took to apply the fix:
> https://support.tools/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/
>
> Thanks for the newsletter,
> Matthew Mattox

### 6.2 awesome-kubernetes pull request (ramitsurana/awesome-kubernetes)

Changes:
- `docs/learning-resources/courses.md`, under `### [Tutorials](#tutorials)`:
  `- [RKE2 the Hard Way](https://support.tools/training/rke2-hard-way/) - 12-part tutorial that builds an RKE2-style cluster by hand: CA and certificates, containerd, etcd, control plane, Cilium, CoreDNS and ingress.`
- `docs/articles/articles.md`, under `### [Networking](#networking)`:
  `- [Cilium MTU Black Hole: How a Linux Bridge and KubeVirt VMs Silently Broke VXLAN](https://support.tools/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/) by [Matthew Mattox](https://github.com/mattmattox)`

PR title: `Add RKE2 the Hard Way tutorial and a Cilium MTU incident article`

PR body:
> Adds two free resources:
> - RKE2 the Hard Way: a 12-part hands-on series in the spirit of Kubernetes the Hard Way, for RKE2's component layout.
> - An incident write-up showing how Cilium's auto-detected MTU can follow a Linux bridge at runtime and black-hole VXLAN traffic when KubeVirt VMs attach to the bridge.
>
> Disclosure: I am the author of both. No paywall, no sign-up.

### 6.3 cilium.io external blog link (cilium/cilium.io)

Follow the README "How to create blog post" section: add a post file with frontmatter similar to:

```yaml
---
path: '/blog/2026/10/27/cilium-mtu-linux-bridge-kubevirt'
date: '2026-10-27T12:00:00.000Z'
title: 'Cilium MTU Black Hole: How a Linux Bridge and KubeVirt VMs Silently Broke VXLAN'
categories:
  - Technology
externalUrl: 'https://support.tools/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/'
ogImageUrl: 'https://cdn.support.tools/posts/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/og-27e9d8bc08.jpg'
ogSummary: 'With no MTU configured, Cilium follows the underlying device MTU at runtime. On a Linux bridge shared with KubeVirt VMs, that device MTU changed under running pods and large VXLAN packets were dropped silently.'
---
```

(Check the exact field names against the README at PR time.)

Optional Slack message in `#cilium-website` first:
> Hi, I wrote an incident write-up about Cilium's MTU auto-detection following a Linux bridge at runtime (KubeVirt VMs on the same bridge pulled it from 9000 to 1500, VXLAN dropped large packets). It is vendor-neutral and ends with the fix (pin `mtu`, flatten the underlay). Would an External blog link PR be welcome?

### 6.4 KubeVirt blog (kubevirt/kubevirt.github.io, original post)

Proposed title: "When a VM changes your node's MTU: KubeVirt, Linux bridges and CNI MTU auto-detection"

Outline (800 to 1,200 words, original text, not a copy):
1. Why VM interfaces on a host Linux bridge matter to the CNI: the bridge MTU equals its smallest port.
2. What happens when a VM with a 1500-byte interface lands on a 9000-byte bridge, and why it is intermittent (depends on where VMs are scheduled and live-migrated).
3. How to check: `ip link show <bridge>`, the CNI's tunnel device MTU, pod MTU, and a `ping -M do -s` test.
4. Mitigations for KubeVirt users: set VM interface MTU explicitly, pin the CNI MTU, keep node underlay and VM bridges separate.
5. Link: "Full incident timeline and the outage plan: https://support.tools/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/"

PR description:
> Adds a community blog post on how VMs attached to a host Linux bridge can change the MTU seen by the cluster network, with checks and mitigations for KubeVirt users. Based on a production incident; the full write-up is linked at the end. Commits are signed off.

### 6.5 Learn Kubernetes Weekly (reply to the latest issue; route not verified)

> Hi Daniele,
>
> Two things your readers might like:
> 1. RKE2 the Hard Way, a free 12-part series that builds an RKE2-style cluster by hand: https://support.tools/training/rke2-hard-way/
> 2. A production incident where Cilium's MTU followed a Linux bridge at runtime and silently dropped large VXLAN packets, keeping Longhorn degraded for ten hours: https://support.tools/cilium-mtu-linux-bridge-kubevirt-vxlan-blackhole-longhorn-degraded/
>
> Thanks for curating,
> Matthew Mattox

## Appendix: method and limits

- Corpus stats came from parsing frontmatter in `blog/content/post/*.md` (2,870 files; published means `date <= 2026-10-21` and not `draft: true`: 799).
- Sitemap stats came from `https://support.tools/sitemap.xml` (341 KB, 2,996 URLs).
- Not verified: Core Web Vitals (PSI quota), Google index coverage (needs GSC), Reddit rules (blocked), DevOps Weekly activity, submission routes for Learn Kubernetes Weekly, DevOps'ish and TLDR DevOps, 2027 CFPs other than KubeCon EU.
- The Stack Exchange and GitHub data came from their public APIs on 2026-10-21.
