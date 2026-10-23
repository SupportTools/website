# PostHog bot filter

`bot-filter.hogql` is true for human events. It removes two bots:

- A headless Chrome that sends one pageview per visitor from a Linux, 1919x992
  window (about 3,900 pageviews in the 30 days to 2026-10-22, 44% of all
  pageviews; Chrome 153 to 156).
- A crawler with an exact 1280x720 viewport, no referrer (`$direct`) and one
  pageview per visitor on `/categories/` and `/tags/` pages, from many countries
  and mixed browsers. It started 2026-10-21 (197 pageviews that day, 70 on
  10-22); before that the same rule matched 0 to 2 pageviews a day. Other
  1280x720 traffic (real readers) is kept.

It is project 78897's test-account filter, with `$host = support.tools`. Keep
"Filter out internal and test users" on in every insight and dashboard tile.
The blog-metrics-exporter embeds this file, so PostHog and Prometheus agree.

Monthly: rerun the Linux Chrome breakdown by exact viewport and pageviews per
visitor (see the plan, Task 4), and watch `blog_bot_pageviews` for a jump.
