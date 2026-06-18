---
title: "Measuring Where Your SaaS Users Actually Come From: Acquisition Attribution as an Engineering Problem"
date: 2032-05-08T09:00:00-05:00
draft: false
tags: ["SaaS", "Analytics", "Attribution", "PostHog", "Plausible", "Matomo", "GDPR", "PostgreSQL", "JavaScript", "Observability", "DevOps", "Privacy"]
categories:
- Analytics
- SaaS
- Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical engineering guide to instrumenting and measuring SaaS user acquisition: capturing referrers and UTM parameters, first-touch vs last-touch attribution, server-side capture, privacy-respecting analytics, and SQL for signup-source funnels."
more_link: "yes"
url: "/measuring-saas-user-acquisition-attribution/"
---

Ask a founder where their users come from and you will usually get a confident answer that turns out to be a guess. The honest version of that answer is "mostly direct, some search, a bit of Twitter," which is another way of saying the data was never captured in a form that could be queried. The reason is rarely laziness; it is that **acquisition attribution** is treated as a marketing concern bolted on after launch, when it is fundamentally a data-capture problem that has to be designed into the signup path from the first commit. If the referrer and campaign parameters are not recorded at the moment a user converts, no dashboard can reconstruct them later.

This post treats acquisition measurement the way you would treat any other observability problem: decide what signal you need, capture it at the source, store it next to the entity it describes, and query it with intent. The examples are concrete -- browser capture code, a SQL schema that lives beside the user record, attribution queries, and self-hosted privacy-respecting analytics -- so that by the end you have a working instrument rather than a vendor pitch.

<!--more-->

## Why "Just Add Google Analytics" Does Not Answer the Question

The default move is to drop a third-party analytics snippet onto the marketing site and assume the question is solved. It is not, for three independent reasons.

First, **aggregate analytics and per-user attribution are different datasets**. Google Analytics 4, Plausible, and similar tools tell you that a channel sent 4,000 sessions and that 1.2 percent converted. They do not tell you that *this specific paying customer* arrived from a Hacker News comment in March, signed up in April, and upgraded in May. The moment you want to join acquisition source to revenue, retention, or support burden, you need the source stored on the user record in your own database -- not trapped in a vendor's session store.

Second, **client-side analytics is lossy by design**. Ad blockers, privacy browsers, the `Do Not Track` and Global Privacy Control signals, and consent banners that default to "reject" all strip events before they fire. Industry measurements of blocked client-side analytics on technical audiences routinely land between 20 and 40 percent. If your SaaS sells to developers -- the exact audience most likely to block trackers -- the channel that looks weakest in GA4 may simply be the channel whose users block GA4. You cannot make a budget decision on a number that is silently undercounting your best segment.

Third, **attribution is a modeling choice, not a fact**. A user who first saw you on a podcast, came back via a newsletter, searched your name on Google, and finally signed up from a direct visit has four legitimate "sources." Which one gets the credit depends on whether you use first-touch, last-touch, or a multi-touch model -- and a tool that hardcodes one model is making that decision for you. Owning the raw touch data lets you change the model later without re-instrumenting.

The goal, then, is not to pick the perfect analytics vendor. It is to capture acquisition signal at the source, store it where it can be joined to everything else you know about the user, and keep the raw inputs so the attribution model stays a query rather than a rebuild.

## The Four Signals Worth Capturing

Before any code, get clear on what "where did this user come from" actually decomposes into. There are four signals, and they answer different questions.

- **Referrer** is the page that linked the user to you, exposed to the browser as `document.referrer` and to the server as the `Referer` header. It answers "what site sent them," but is increasingly blank because of referrer-policy restrictions and HTTPS-to-HTTP downgrades.
- **UTM parameters** are the campaign tags you append to your own links -- `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`. They answer "which of *my* deliberate placements did they click," and they are only as good as your discipline in tagging every link you control.
- **Channel** is the coarse bucket you derive from the above: `organic_search`, `social`, `referral`, `direct`, `email`, `paid`. It is the dimension you will actually group by in reports, because the raw referrer host space is too sparse to read.
- **Landing page** is the first URL on your property the user touched. It answers "which piece of content did the work," and it is the signal most often forgotten despite being the easiest to capture.

A workable instrument captures all four, derives the channel deterministically, and never throws away the raw inputs that the channel was derived from. The derivation is a convenience for reading; the raw referrer and UTM values are the source of truth.

## Client-Side Capture: First-Touch, Written Once

The first piece of instrumentation runs in the browser and records the acquisition context on the *first* visit, before the user has clicked around and overwritten `document.referrer` with internal navigation. This is the **first-touch** capture, and the cardinal rule is that it is written exactly once and never overwritten.

```javascript
// acquisition.js - first-touch capture, runs once per browser on first visit
(function () {
  "use strict";

  var STORAGE_KEY = "acq_first_touch";
  var SESSION_KEY = "acq_last_touch";
  var MAX_AGE_DAYS = 90;

  // Parse the current URL's query string into a plain object.
  function parseQuery(search) {
    var params = {};
    var query = (search || "").replace(/^\?/, "");
    if (!query) {
      return params;
    }
    query.split("&").forEach(function (pair) {
      var kv = pair.split("=");
      var key = decodeURIComponent(kv[0] || "");
      var value = decodeURIComponent((kv[1] || "").replace(/\+/g, " "));
      if (key) {
        params[key] = value;
      }
    });
    return params;
  }

  // Classify a referrer hostname into a coarse channel bucket.
  function classifyChannel(utm, referrer) {
    if (utm.utm_medium) {
      return utm.utm_medium.toLowerCase();
    }
    if (!referrer) {
      return "direct";
    }
    var host = "";
    try {
      host = new URL(referrer).hostname.toLowerCase();
    } catch (e) {
      return "referral";
    }
    var searchEngines = ["google.", "bing.", "duckduckgo.", "ecosia."];
    var social = ["twitter.", "x.com", "linkedin.", "facebook.", "reddit."];
    if (searchEngines.some(function (s) { return host.indexOf(s) !== -1; })) {
      return "organic_search";
    }
    if (social.some(function (s) { return host.indexOf(s) !== -1; })) {
      return "social";
    }
    return "referral";
  }

  function buildTouch() {
    var utm = parseQuery(window.location.search);
    var referrer = document.referrer || "";
    return {
      ts: new Date().toISOString(),
      landing_page: window.location.pathname,
      referrer: referrer,
      utm_source: utm.utm_source || null,
      utm_medium: utm.utm_medium || null,
      utm_campaign: utm.utm_campaign || null,
      utm_term: utm.utm_term || null,
      utm_content: utm.utm_content || null,
      gclid: utm.gclid || null,
      channel: classifyChannel(utm, referrer)
    };
  }

  function readJSON(store, key) {
    try {
      return JSON.parse(store.getItem(key) || "null");
    } catch (e) {
      return null;
    }
  }

  var touch = buildTouch();

  // First-touch is written exactly once and never overwritten.
  var existing = readJSON(window.localStorage, STORAGE_KEY);
  if (!existing) {
    touch.expires_days = MAX_AGE_DAYS;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(touch));
  }

  // Last-touch is refreshed on every campaign-bearing visit.
  if (touch.utm_source || touch.referrer) {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(touch));
  }
})();
```

Three design decisions are worth calling out. The first-touch object goes in `localStorage` so it survives across sessions for the full attribution window; the last-touch goes in `sessionStorage` so it always reflects the most recent campaign-bearing arrival. The channel is derived at capture time but the raw `referrer` and UTM fields are kept alongside it, so a later change to your channel-classification rules can be replayed against historical data. And the `gclid` -- Google's click identifier -- is captured separately because paid-search reconciliation depends on it and it is not a UTM parameter.

The obvious limitation is that anything stored client-side is lost the instant the user clears storage or switches devices. That is acceptable for first-touch because the alternative -- not capturing it at all -- is worse, but it is precisely why the server-side capture in a later section exists.

### Making Client Capture More Robust

The capture above is the readable version. A production instrument has to survive a handful of conditions the simple version does not: a browser in a privacy mode where `localStorage` throws on write, a user arriving through one of the dozen click identifiers that are not `gclid`, and -- most insidiously -- internal links being misread as referrals. The hardened version below addresses all three. It mirrors the first-touch object into a cookie so the value survives even when `localStorage` is wiped or unavailable, widens the set of tracking parameters it persists, and explicitly discards a referrer that points back at your own hostname.

```javascript
// Robust first-touch + last-touch capture with cookie mirror of localStorage,
// so the acquisition context survives even when a privacy mode wipes one store.
(function () {
  "use strict";

  var FIRST_KEY = "acq_first_touch";
  var LAST_KEY = "acq_last_touch";
  var COOKIE_NAME = "acq_ft";
  var WINDOW_DAYS = 90;

  // Tracking parameters worth persisting beyond the standard five UTM tags.
  var TRACKING_PARAMS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "gclid", "fbclid", "msclkid", "ref", "via"
  ];

  function parseQuery(search) {
    var out = {};
    var qs = (search || "").replace(/^\?/, "");
    if (!qs) {
      return out;
    }
    qs.split("&").forEach(function (pair) {
      var idx = pair.indexOf("=");
      var key = decodeURIComponent(idx < 0 ? pair : pair.slice(0, idx));
      var raw = idx < 0 ? "" : pair.slice(idx + 1);
      var val = decodeURIComponent(raw.replace(/\+/g, " "));
      if (key) {
        out[key] = val;
      }
    });
    return out;
  }

  // Reject our own hostname so an internal link is never counted as a referrer.
  function isSelfReferral(referrer) {
    if (!referrer) {
      return false;
    }
    try {
      return new URL(referrer).hostname === window.location.hostname;
    } catch (e) {
      return false;
    }
  }

  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie =
      name + "=" + encodeURIComponent(value) +
      ";expires=" + expires +
      ";path=/;SameSite=Lax;Secure";
  }

  function getCookie(name) {
    var match = document.cookie.match(
      new RegExp("(?:^|; )" + name + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function buildTouch() {
    var params = parseQuery(window.location.search);
    var referrer = document.referrer || "";
    if (isSelfReferral(referrer)) {
      referrer = "";
    }
    var touch = {
      ts: new Date().toISOString(),
      landing_page: window.location.pathname,
      referrer: referrer
    };
    TRACKING_PARAMS.forEach(function (p) {
      if (params[p]) {
        touch[p] = params[p];
      }
    });
    return touch;
  }

  function readStored() {
    var fromLocal = null;
    try {
      fromLocal = JSON.parse(window.localStorage.getItem(FIRST_KEY) || "null");
    } catch (e) {
      fromLocal = null;
    }
    if (fromLocal) {
      return fromLocal;
    }
    var fromCookie = getCookie(COOKIE_NAME);
    if (fromCookie) {
      try {
        return JSON.parse(fromCookie);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  var touch = buildTouch();
  var hasCampaign = !!(touch.utm_source || touch.referrer || touch.ref);

  // First-touch: written exactly once, mirrored to a cookie for durability.
  var existing = readStored();
  if (!existing) {
    var serialized = JSON.stringify(touch);
    try {
      window.localStorage.setItem(FIRST_KEY, serialized);
    } catch (e) {
      // localStorage may be unavailable in private modes; the cookie still works.
    }
    setCookie(COOKIE_NAME, serialized, WINDOW_DAYS);
  }

  // Last-touch: refreshed on every campaign-bearing visit.
  if (hasCampaign) {
    try {
      window.sessionStorage.setItem(LAST_KEY, JSON.stringify(touch));
    } catch (e) {
      // Non-fatal: last-touch is best-effort.
    }
  }
})();
```

Three robustness details earn their place. The `isSelfReferral` check is the one most teams miss: without it, a user who lands on your blog, clicks through to your pricing page, and signs up there will record your *own* blog as the "referrer" on a fresh capture -- a self-referral that pollutes the referral channel with internal traffic. The cookie mirror means a privacy mode that disables `localStorage` (Safari's Private Browsing historically threw on `setItem`) does not silently drop the first-touch entirely; the `try/catch` around every storage write ensures a storage failure degrades to a cookie rather than an uncaught exception on your marketing page. And the expanded `TRACKING_PARAMS` list captures `fbclid`, `msclkid`, and the generic `ref`/`via` conventions that many newsletters and link shorteners use, so paid social and partner links are not flattened into "direct" for want of a recognized parameter.

The `SameSite=Lax` and `Secure` attributes on the cookie are deliberate: `Lax` allows the cookie to ride along on top-level navigations (the case that matters for attribution) while blocking it from most cross-site contexts, and `Secure` keeps it off plaintext connections. This is a strictly first-party cookie used only to remember where *this* browser first found you; it is not a cross-site tracking cookie, which is both why it is defensible under most consent regimes and why it does not require the third-party cookie machinery that browsers are actively dismantling.

## Carrying Acquisition Data Into the Signup

Captured acquisition data is useless until it reaches your backend attached to a real user. The bridge is the signup form: just before submission, hydrate hidden fields with the stored touch objects so they travel in the same request that creates the account.

```javascript
// Attach stored acquisition data to the signup form before submission.
function hydrateSignupForm(form) {
  var firstTouch = safeParse(localStorage.getItem("acq_first_touch"));
  var lastTouch = safeParse(sessionStorage.getItem("acq_last_touch"));

  setHidden(form, "first_touch", firstTouch);
  setHidden(form, "last_touch", lastTouch);
}

function safeParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function setHidden(form, name, value) {
  var input = form.querySelector('input[name="' + name + '"]');
  if (!input) {
    input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    form.appendChild(input);
  }
  input.value = value ? JSON.stringify(value) : "";
}

document.addEventListener("DOMContentLoaded", function () {
  var form = document.querySelector("form#signup");
  if (form) {
    hydrateSignupForm(form);
  }
});
```

This keeps the acquisition payload inside the normal form submission, which means it works without a separate analytics request that an ad blocker might cancel. If your signup is a single-page-application flow rather than a form POST, the same two `JSON.stringify` payloads go into the JSON body of your signup API call. The point is that acquisition data rides along with the conversion event itself, not on a side channel that can be dropped independently.

## Server-Side Capture: The Signal Browsers Cannot Forge or Block

Client-side capture is necessary but not sufficient. The server sees signals the browser either cannot block or cannot be trusted to report honestly, and the conversion request is the one moment you are guaranteed to control. **Server-side capture** at signup is where you record the data that client-side instrumentation misses.

```javascript
// Express handler that records acquisition data server-side at signup time.
const crypto = require("crypto");

function parseTouch(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

async function handleSignup(req, res, db) {
  const firstTouch = parseTouch(req.body.first_touch);
  const lastTouch = parseTouch(req.body.last_touch);

  // Server-side signals that the browser cannot forge.
  const serverReferrer = req.get("referer") || null;
  const userAgent = req.get("user-agent") || null;
  const ipHash = crypto
    .createHash("sha256")
    .update((req.ip || "") + process.env.IP_SALT)
    .digest("hex");

  const userId = await db.createUser({
    email: req.body.email,
    acq_first_touch: firstTouch,
    acq_last_touch: lastTouch,
    acq_server_referrer: serverReferrer,
    acq_user_agent: userAgent,
    acq_ip_hash: ipHash
  });

  return res.status(201).json({ id: userId });
}

module.exports = { handleSignup, parseTouch };
```

The server-side handler does three things the browser cannot. It reads the `Referer` header directly, which survives even when client-side referrer capture is suppressed by a strict referrer policy. It records the user agent for later bot filtering and device-class reporting. And it stores a **salted hash of the IP address** -- never the raw IP -- which can be passed to a GeoIP lookup for country-level acquisition reporting without retaining personally identifiable network data. The salt comes from an environment variable so the hashes are not reversible with a precomputed table, and the raw IP is discarded the moment the hash is computed.

Note the deliberate paranoia in `parseTouch`: anything coming from `req.body` is attacker-controlled, so the function never assumes the payload is valid JSON or even an object. A malformed or hostile `first_touch` field degrades to an empty object rather than crashing the signup path. Acquisition data is nice to have; completing the signup is the actual job, and instrumentation must never be able to block it.

## Storing Acquisition Data Next to the User

The captured signals need a home in your database, and the design choice is whether to widen the `users` table or to give acquisition its own table. Use a separate table. It keeps the frequently read user row small, lets analytics queries run without contending with application reads, and makes the acquisition data trivial to drop wholesale if a retention policy or deletion request requires it.

```sql
-- Acquisition data stored on a dedicated table, keyed to the user.
-- Keeping it separate from the users table keeps the hot user row small
-- and lets analytics queries run without locking application reads.
CREATE TABLE user_acquisition (
    user_id          BIGINT       PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    -- First-touch: the very first campaign/referrer we ever saw for this browser.
    first_channel    TEXT         NOT NULL DEFAULT 'direct',
    first_source     TEXT,
    first_medium     TEXT,
    first_campaign   TEXT,
    first_referrer   TEXT,
    first_landing    TEXT,
    first_seen_at    TIMESTAMPTZ,
    -- Last-touch: the campaign/referrer present on the converting visit.
    last_channel     TEXT         NOT NULL DEFAULT 'direct',
    last_source      TEXT,
    last_medium      TEXT,
    last_campaign    TEXT,
    last_referrer    TEXT,
    -- Server-side enrichment captured at signup time.
    server_referrer  TEXT,
    ip_country       TEXT,
    signup_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Channel is the most common filter and group-by dimension.
CREATE INDEX idx_user_acq_first_channel ON user_acquisition (first_channel);
CREATE INDEX idx_user_acq_last_channel  ON user_acquisition (last_channel);
CREATE INDEX idx_user_acq_signup_at     ON user_acquisition (signup_at);
CREATE INDEX idx_user_acq_campaign      ON user_acquisition (first_campaign)
    WHERE first_campaign IS NOT NULL;
```

The `ON DELETE CASCADE` is not incidental: when a user is deleted -- including for a right-to-erasure request -- their acquisition record goes with them automatically. The partial index on `first_campaign` keeps the index small by excluding the large fraction of users who arrived without a campaign tag. Channel columns get plain indexes because they are the dimensions every report groups by.

A reasonable alternative is to store the raw `first_touch` and `last_touch` payloads as `JSONB` and derive the flat columns in queries. That is more flexible but slower to aggregate and harder to index. The flat-column approach shown here is the right default for a SaaS with tens of thousands of users; reach for `JSONB` only if your touch payloads are genuinely variable. A pragmatic middle ground is to keep both: the flat columns you group by every day, plus a single `raw_first_touch JSONB` column holding the untouched capture payload, so a future field you forgot to flatten -- a click identifier from an ad network you had not run yet -- is still recoverable without a backfill from logs you may not have kept.

### Two More Tables: The Raw Touch Log and the Survey Answer

The `user_acquisition` table holds the *resolved* first- and last-touch for each user, which is all the first-touch and last-touch reports need. Two capabilities discussed later -- multi-touch attribution and cross-referencing against a "How did you hear about us?" survey -- need data that does not fit on a one-row-per-user table, so they get their own tables.

```sql
-- Raw touch-event log for multi-touch attribution. One row per campaign-bearing
-- visit, keyed by an anonymous device id, joined to the user only at signup.
CREATE TABLE acquisition_touches (
    id            BIGSERIAL    PRIMARY KEY,
    device_id     TEXT         NOT NULL,
    user_id       BIGINT       REFERENCES users (id) ON DELETE CASCADE,
    channel       TEXT         NOT NULL,
    source        TEXT,
    campaign      TEXT,
    referrer      TEXT,
    landing_page  TEXT,
    ts            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Touches are queried per device, ordered by time, for windowed attribution.
CREATE INDEX idx_touches_device_ts ON acquisition_touches (device_id, ts);
CREATE INDEX idx_touches_user      ON acquisition_touches (user_id)
    WHERE user_id IS NOT NULL;

-- "How did you hear about us?" survey answer captured at signup, stored so it
-- can be cross-referenced against the automatically captured channel.
CREATE TABLE acquisition_survey (
    user_id        BIGINT      PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    self_reported  TEXT        NOT NULL,
    answered_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The `acquisition_touches` table is initially keyed by an anonymous `device_id` -- a random identifier minted in `localStorage` on first visit -- with a null `user_id`. Every campaign-bearing pageview appends a row. At signup, you stamp the converting user's `id` onto all the device's touches in a single `UPDATE ... WHERE device_id = $1`, which retroactively links the entire pre-conversion journey to the account. Rows that never convert keep their null `user_id` and can be aged out aggressively, since an anonymous touch that produced no signup has no analytical value after the attribution window closes. Both tables carry `ON DELETE CASCADE` so a user deletion takes their touch log and survey answer with it, the same erasure guarantee as the main table.

## A Server-Side Event Pipeline That Does Not Slow Down Signup

The server-side handler shown earlier wrote acquisition data inline during the signup request. That is fine at low volume, but it couples two things that should be decoupled: completing the signup, which must be fast and reliable, and enriching the acquisition data with GeoIP lookups and channel normalization, which is neither. A GeoIP lookup that hangs should never add latency to account creation, and a transient failure in enrichment should never roll back a signup. The fix is the standard one for any "do expensive work after a fast write" problem: enqueue a raw event during the request, and let a separate worker do the enrichment asynchronously.

The handler's job shrinks to validating the payload, hashing the IP, and publishing a raw event to a queue -- a few milliseconds. A pool of workers then consumes events, classifies the channel, performs the GeoIP lookup against the hashed IP, and upserts the flat columns onto `user_acquisition`.

```javascript
// Server-side event-pipeline worker: consumes raw acquisition events from a
// queue, normalizes the channel, enriches with GeoIP, and upserts the flat
// columns onto user_acquisition. Decoupling capture from enrichment keeps the
// signup request fast and lets enrichment fail without dropping the signup.
const SEARCH_ENGINES = ["google.", "bing.", "duckduckgo.", "ecosia.", "brave."];
const SOCIAL = ["twitter.", "x.com", "linkedin.", "facebook.", "reddit.", "news.ycombinator.com"];

function classifyChannel(touch) {
  if (touch.utm_medium) {
    return touch.utm_medium.toLowerCase();
  }
  if (touch.gclid || touch.msclkid) {
    return "paid_search";
  }
  if (touch.fbclid) {
    return "paid_social";
  }
  if (!touch.referrer) {
    return "direct";
  }
  let host;
  try {
    host = new URL(touch.referrer).hostname.toLowerCase();
  } catch (e) {
    return "referral";
  }
  if (SEARCH_ENGINES.some((s) => host.indexOf(s) !== -1)) {
    return "organic_search";
  }
  if (SOCIAL.some((s) => host.indexOf(s) !== -1)) {
    return "social";
  }
  return "referral";
}

async function processEvent(event, deps) {
  const { db, geoip } = deps;
  const first = event.first_touch || {};
  const last = event.last_touch || {};

  const country = event.ip_hash ? await geoip.countryFor(event.ip_hash) : null;

  await db.query(
    `INSERT INTO user_acquisition (
        user_id, first_channel, first_source, first_medium, first_campaign,
        first_referrer, first_landing, first_seen_at,
        last_channel, last_source, last_medium, last_campaign, last_referrer,
        server_referrer, ip_country, signup_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (user_id) DO NOTHING`,
    [
      event.user_id,
      classifyChannel(first),
      first.utm_source || null,
      first.utm_medium || null,
      first.utm_campaign || null,
      first.referrer || null,
      first.landing_page || null,
      first.ts || null,
      classifyChannel(last),
      last.utm_source || null,
      last.utm_medium || null,
      last.utm_campaign || null,
      last.referrer || null,
      event.server_referrer || null,
      country
    ]
  );
}

async function runWorker(queue, deps) {
  // Long-poll the queue; ack only after a successful upsert so a crash
  // mid-enrichment redelivers the event rather than losing it.
  for (;;) {
    const event = await queue.receive();
    if (!event) {
      continue;
    }
    try {
      await processEvent(event.body, deps);
      await queue.ack(event.handle);
    } catch (err) {
      // Leave the message for redelivery; a dead-letter queue catches poison events.
      await queue.nack(event.handle);
    }
  }
}

module.exports = { classifyChannel, processEvent, runWorker };
```

Two properties make this safe. The `ON CONFLICT (user_id) DO NOTHING` makes the upsert idempotent: if a worker crashes after writing but before acking, the redelivered event re-runs the insert harmlessly rather than creating a duplicate or failing on the primary key. And the `ack`-after-success, `nack`-on-failure pattern gives at-least-once delivery, so a GeoIP outage parks events for retry instead of discarding acquisition data. Channel classification has moved server-side here, which is the better home for it: the rules are centralized, versioned with your backend, and applied uniformly to events from every client regardless of what an outdated cached `acquisition.js` might have computed.

Deploying the worker is unremarkable -- it is a stateless consumer that scales horizontally with queue depth.

```yaml
# Kubernetes Deployment for the acquisition enrichment worker. The worker reads
# raw events from a queue and upserts the flat columns onto user_acquisition,
# keeping the signup request path free of enrichment latency.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: acquisition-worker
  namespace: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: acquisition-worker
  template:
    metadata:
      labels:
        app: acquisition-worker
    spec:
      containers:
        - name: worker
          image: registry.example.com/acquisition-worker:1.4.0
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: acquisition-secrets
                  key: database-url
            - name: QUEUE_URL
              valueFrom:
                secretKeyRef:
                  name: acquisition-secrets
                  key: queue-url
            - name: IP_SALT
              valueFrom:
                secretKeyRef:
                  name: acquisition-secrets
                  key: ip-salt
            - name: GEOIP_DB_PATH
              value: /data/GeoLite2-Country.mmdb
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 128Mi
          volumeMounts:
            - name: geoip
              mountPath: /data
              readOnly: true
      volumes:
        - name: geoip
          configMap:
            name: geoip-database
```

The `IP_SALT` lives in a secret rather than a plain environment value because it is the thing standing between your stored hashes and a precomputed-table attack; rotate it like any other secret, accepting that rotation makes pre-rotation hashes uncorrelatable with post-rotation ones, which for country-level GeoIP is a non-issue. For a small SaaS this asynchronous pipeline is admittedly more machinery than the inline handler, and the inline version is a perfectly good starting point. Reach for the queue when GeoIP latency starts showing up in your signup p99, or when you want to replay enrichment after fixing a classification bug -- at which point having the raw events in a queue's archive, or in an append-only `raw_first_touch` column, turns a "we lost that data" conversation into a backfill job.

## First-Touch Versus Last-Touch, and Why the Gap Matters

With the data landed, the first real questions are answerable in plain SQL. Start with the headline report -- signups by the channel that *introduced* each user -- and then immediately look at how often the introducing channel differs from the converting one.

```sql
-- Signups by first-touch channel for the trailing 30 days.
SELECT
    first_channel,
    count(*) AS signups
FROM user_acquisition
WHERE signup_at >= now() - INTERVAL '30 days'
GROUP BY first_channel
ORDER BY signups DESC;

-- First-touch versus last-touch divergence: how often the channel that
-- introduced a user differs from the one that converted them.
SELECT
    first_channel,
    last_channel,
    count(*) AS users
FROM user_acquisition
GROUP BY first_channel, last_channel
HAVING count(*) > 5
ORDER BY users DESC;
```

The divergence query is the one that changes minds. **First-touch attribution** credits the channel that first made the user aware of you; **last-touch attribution** credits the channel present at conversion. They disagree constantly. A user discovered through a conference talk who later converts from a direct visit will show as `referral -> direct` in the divergence report. If you only measured last-touch, you would conclude that "direct" drives signups and quietly defund the conference budget that actually created the awareness. If you only measured first-touch, you would over-credit top-of-funnel content and ignore the email sequence that closed the deal. Keeping both columns lets you see the gap instead of pretending it does not exist.

## The Funnel That Actually Matters: Channel to Revenue

Signups are a vanity metric if the channels that produce them produce users who never pay. The query that earns its keep joins acquisition to your subscription state, so you measure paying conversion per channel rather than raw signup volume.

```sql
-- Channel-to-paid funnel: joins acquisition to a subscriptions table to
-- measure which channel produces paying customers, not just signups.
SELECT
    a.first_channel,
    count(DISTINCT a.user_id)                              AS signups,
    count(DISTINCT s.user_id)                              AS paid,
    round(
        100.0 * count(DISTINCT s.user_id)
        / nullif(count(DISTINCT a.user_id), 0),
        1
    )                                                      AS conversion_pct
FROM user_acquisition a
LEFT JOIN subscriptions s
       ON s.user_id = a.user_id
      AND s.status = 'active'
WHERE a.signup_at >= now() - INTERVAL '90 days'
GROUP BY a.first_channel
ORDER BY paid DESC;

-- Campaign-level breakdown for a single paid source.
SELECT
    first_campaign,
    count(*) AS signups,
    min(signup_at) AS first_signup,
    max(signup_at) AS last_signup
FROM user_acquisition
WHERE first_source = 'newsletter'
  AND first_campaign IS NOT NULL
GROUP BY first_campaign
ORDER BY signups DESC;
```

This funnel routinely upends the signup-volume ranking. A channel that delivers a flood of free-tier signups with a 1 percent paid conversion is worth less than a channel delivering a quarter of the volume at 12 percent. The `nullif` guard prevents a division-by-zero when a channel has signups but no joins yet, and the `LEFT JOIN` keeps channels with zero paid conversions visible rather than dropping them -- the channels that produce no revenue are exactly the ones you most need to see.

## Multi-Touch Attribution When First and Last Are Not Enough

First-touch and last-touch are two endpoints of a spectrum. For a longer or more deliberate buying journey, you may want to credit every touch along the way, which requires logging *all* campaign visits to an `acquisition_touches` table keyed by an anonymous device identifier -- not just the first and last. With that raw event log, a **position-based (U-shaped) model** can be expressed in a single query.

```sql
-- Position-based (U-shaped) attribution from a raw touch-event log.
-- 40% credit to first touch, 40% to last, 20% split across the middle.
-- This assumes an acquisition_touches table that logs every campaign
-- visit, not just the first and last, keyed by an anonymous device id.
WITH ranked AS (
    SELECT
        device_id,
        channel,
        ts,
        row_number() OVER (PARTITION BY device_id ORDER BY ts)        AS pos_asc,
        row_number() OVER (PARTITION BY device_id ORDER BY ts DESC)   AS pos_desc,
        count(*)    OVER (PARTITION BY device_id)                     AS touch_count
    FROM acquisition_touches
),
credited AS (
    SELECT
        channel,
        CASE
            WHEN touch_count = 1                       THEN 1.0
            WHEN pos_asc = 1                           THEN 0.4
            WHEN pos_desc = 1                          THEN 0.4
            ELSE 0.2 / nullif(touch_count - 2, 0)
        END AS credit
    FROM ranked
)
SELECT
    channel,
    round(sum(credit), 2) AS attributed_conversions
FROM credited
GROUP BY channel
ORDER BY attributed_conversions DESC;
```

The model lives entirely in the `CASE` expression. A lone touch gets full credit; the first and last touches get 40 percent each; the remaining 20 percent is divided across the middle touches. Because the credit is computed from the raw log rather than hardcoded at capture time, switching to a linear model (equal credit to every touch) or a time-decay model (more credit to recent touches) is a query change, not a re-instrumentation. This is the entire payoff of keeping the raw touch data: the attribution model becomes a question you ask, not an architecture you commit to.

To make that point concrete, here are two more models against the same `acquisition_touches` log. The linear model spreads one full conversion equally across every touch on a converting device, which is the right baseline when you have no strong prior about which positions matter. The time-decay model weights recent touches more heavily on the theory that the touch closest to conversion did the most work, with the weight halving every seven days as you walk back in time.

```sql
-- Linear (equal-credit) multi-touch attribution: every touch on a converting
-- device gets an equal share of one conversion.
SELECT
    channel,
    round(sum(1.0 / per_device.touch_count), 2) AS attributed_conversions
FROM acquisition_touches t
JOIN (
    SELECT device_id, count(*) AS touch_count
    FROM acquisition_touches
    WHERE user_id IS NOT NULL
    GROUP BY device_id
) per_device ON per_device.device_id = t.device_id
WHERE t.user_id IS NOT NULL
GROUP BY channel
ORDER BY attributed_conversions DESC;

-- Time-decay attribution: a touch closer to conversion earns more credit.
-- Weight halves every 7 days before the final touch on each device.
WITH last_touch AS (
    SELECT device_id, max(ts) AS converted_at
    FROM acquisition_touches
    WHERE user_id IS NOT NULL
    GROUP BY device_id
),
weighted AS (
    SELECT
        t.channel,
        power(
            0.5,
            extract(epoch FROM (l.converted_at - t.ts)) / (7 * 86400)
        ) AS weight
    FROM acquisition_touches t
    JOIN last_touch l ON l.device_id = t.device_id
    WHERE t.user_id IS NOT NULL
)
SELECT
    channel,
    round((sum(weight) / sum(sum(weight)) OVER ()) * 100, 1) AS credit_pct
FROM weighted
GROUP BY channel
ORDER BY credit_pct DESC;
```

The time-decay query is the more interesting of the two. The `power(0.5, days / 7)` expression is an exponential half-life: a touch on the conversion day has weight 1.0, a touch seven days earlier has weight 0.5, fourteen days earlier 0.25, and so on. The `sum(sum(weight)) OVER ()` is a window aggregate over a grouped result -- a Postgres idiom that divides each channel's total weight by the grand total to express credit as a percentage in one pass. The trade-off across all of these models is straightforward to state and impossible to resolve universally: first-touch over-credits awareness, last-touch over-credits closing, linear refuses to take a position, position-based bets that the ends matter most, and time-decay bets that recency matters most. None is correct in the abstract; the right one depends on whether your buying journey is a quick impulse signup or a months-long evaluation. The architectural win is that you can compute all five from the same log and compare them, rather than discovering after six months that you instrumented the wrong one.

## Privacy-Respecting Analytics: Self-Hosted and First-Party

Owning the per-user attribution in your own database covers the high-value join to revenue. For aggregate browsing behavior -- which marketing pages convert, how the funnel performs in total -- you still want a proper analytics tool, and the privacy-respecting, self-hosted options are both more accurate for technical audiences and far less of a compliance liability than the ad-tech defaults.

**Plausible** is the lightest option: cookieless, no personal data retained, and small enough to self-host beside your application. Running it yourself keeps the data on infrastructure you control.

```yaml
# docker-compose.yml - self-hosted Plausible Analytics, privacy-respecting
# and cookieless. Runs alongside the SaaS for aggregate channel reporting.
services:
  plausible_db:
    image: postgres:16-alpine
    restart: always
    volumes:
      - plausible-db-data:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: "${PLAUSIBLE_DB_PASSWORD}"

  plausible_events_db:
    image: clickhouse/clickhouse-server:24.3-alpine
    restart: always
    volumes:
      - plausible-events-data:/var/lib/clickhouse
    ulimits:
      nofile:
        soft: 262144
        hard: 262144

  plausible:
    image: ghcr.io/plausible/community-edition:v2.1
    restart: always
    command: sh -c "/entrypoint.sh db migrate && /entrypoint.sh run"
    depends_on:
      - plausible_db
      - plausible_events_db
    ports:
      - "127.0.0.1:8000:8000"
    environment:
      BASE_URL: "https://analytics.example.com"
      SECRET_KEY_BASE: "${PLAUSIBLE_SECRET_KEY_BASE}"
      DATABASE_URL: "postgres://postgres:${PLAUSIBLE_DB_PASSWORD}@plausible_db:5432/plausible_db"
      CLICKHOUSE_DATABASE_URL: "http://plausible_events_db:8123/plausible_events_db"

volumes:
  plausible-db-data:
  plausible-events-data:
```

**PostHog** is the heavier choice when you want product analytics, funnels, and session-level event data in addition to acquisition. Its defining tactic for accurate capture is the **first-party reverse proxy**: you serve the analytics ingestion endpoint from your own domain so that browser ad-block lists, which target known analytics hostnames, do not recognize and drop the requests. In Kubernetes that proxy is a few lines of configuration.

```yaml
# Kubernetes ConfigMap: a first-party reverse proxy for PostHog ingestion.
# Serving the analytics endpoint from your own domain defeats most ad blockers
# and keeps acquisition events flowing from privacy-hardened browsers.
apiVersion: v1
kind: ConfigMap
metadata:
  name: analytics-proxy
  namespace: web
data:
  nginx.conf: |
    location /ingest/static/ {
      proxy_pass https://us-assets.i.posthog.com/static/;
      proxy_set_header Host us-assets.i.posthog.com;
    }
    location /ingest/ {
      proxy_pass https://us.i.posthog.com/;
      proxy_set_header Host us.i.posthog.com;
      proxy_ssl_server_name on;
    }
```

The client then points at the proxy path on your own domain rather than at PostHog's hosts directly, and identifies the user at signup so the anonymous pre-conversion pageviews are stitched to the real account.

```javascript
// PostHog initialization pointed at the first-party reverse proxy.
// person_profiles is set to capture only identified users to limit
// the amount of behavioural data retained on anonymous visitors.
import posthog from "posthog-js";

posthog.init("phc_PROJECT_API_KEY", {
  api_host: "https://app.example.com/ingest",
  ui_host: "https://us.posthog.com",
  person_profiles: "identified_only",
  capture_pageview: true,
  persistence: "localStorage+cookie"
});

// Link the anonymous pre-signup session to the new user record so the
// pageviews that led to conversion are attributed to the right person.
export function identifyUser(userId, traits) {
  posthog.identify(userId, traits);
}
```

**Matomo** sits between the two as a mature, self-hostable Google Analytics replacement with a configurable cookieless mode and full data ownership. The common thread across all three is that the analytics data lives on infrastructure you control, which both improves capture rates on privacy-hardened browsers and simplifies the compliance story considerably. The reverse-proxy trick is not about deceiving users; it is about not letting a generic block list silently delete the data of the exact technical audience you most need to measure.

### Choosing Between Self-Hosted and GA4

The honest trade-off, stated plainly, is that GA4 is free, ubiquitous, and the default that every marketing contractor already knows -- and that those conveniences come at the cost of the three things this entire post is about: data ownership, capture accuracy on technical audiences, and a clean compliance story.

- **Capture accuracy.** GA4 is served from `google-analytics.com` and `googletagmanager.com`, both on every ad-block and privacy-list by default. On a developer audience you should expect to lose a large minority of events outright. Self-hosted Plausible, Matomo, or a reverse-proxied PostHog are not on those lists, so they capture the segment GA4 cannot see. If your buyers are engineers, this alone is decisive.
- **Data ownership and joins.** GA4's data lives in Google's system; getting per-user, joinable data out of it means wiring up the BigQuery export and reconciling its event model with your database. The self-hosted tools either keep the raw events in a database you already query (PostHog on ClickHouse, Matomo on MySQL) or, in Plausible's case, deliberately keep no per-user data at all. The per-user attribution that actually matters still belongs in your own `user_acquisition` table regardless of which aggregate tool you pick -- the aggregate tool answers "which pages convert," not "which customer came from where."
- **Compliance.** GA4 transfers personal data to Google and, depending on configuration and jurisdiction, has been the subject of repeated regulatory challenges in the EU over transatlantic data transfer. Cookieless Plausible and Matomo's cookieless mode let you run aggregate analytics with no consent banner because there is no personal data and no cross-site cookie to consent to. That is a materially shorter compliance conversation.
- **Cost and operational burden.** This is where GA4 wins. It is free and requires no servers. Self-hosting means running a database, an ingestion service, and keeping them patched and backed up -- real operational work. PostHog is the heaviest; Plausible is light enough to run in the Compose file above on a small instance. For a team without infrastructure to spare, GA4 plus the owned per-user attribution in your database is a defensible compromise: you concede aggregate-traffic accuracy but keep the revenue-joinable signal that drives budget decisions.

The decision is rarely "all or nothing." A common and sensible setup is per-user attribution in your own database (the non-negotiable core), Plausible or Matomo for cookieless aggregate marketing-site analytics (the consent-free default), and PostHog only if you need product analytics deep enough to justify its weight. GA4 earns a place mainly when an external marketing team requires it or when the operational cost of self-hosting genuinely cannot be borne.

## Handling Dark Traffic and the "Direct" Bucket

The single most misleading number in any acquisition report is **direct traffic**, because "direct" is not really a channel. It is the bucket where everything with no detectable referrer lands: someone who typed your URL, yes, but also clicks from native mobile apps, links inside email clients that strip the referrer, traffic from messaging apps, anything moving from HTTPS to a context that drops the header, and links shared in private channels. This is collectively called **dark traffic**, and treating it as "people who already knew us" overstates your brand strength and hides the channels actually feeding it.

There are three practical mitigations. First, **tag every link you control with UTM parameters**, religiously -- newsletter links, social posts, documentation cross-links, the footer of your transactional emails. A tagged link cannot fall into the direct bucket. Second, **capture the landing page**, because a "direct" visit that lands on a deep, unmemorable URL like `/blog/some-niche-debugging-guide` was almost certainly shared somewhere; nobody types that from memory, so the landing page tells you the content did the acquisition even when the referrer is blank. Third, **cross-reference the survey signal**: a one-question "How did you hear about us?" field on the signup form, stored alongside the captured data, lets you measure how much of your "direct" bucket is genuinely direct versus dark traffic from a specific source. When the self-reported source and the captured channel disagree, the disagreement itself is the finding.

That survey question is worth dwelling on. The most reliable acquisition signal a SaaS can collect is often the user simply telling you, in their own words, where they heard about you -- a technique that costs one form field and routinely surfaces channels no automated capture would ever catch, like a recommendation in a private Slack community. The instrumentation in this post and the direct-ask survey are complements, not competitors: the captured data scales and joins to revenue, while the survey catches the dark-traffic sources the instrumentation structurally cannot see.

With the survey answer stored in the `acquisition_survey` table, the cross-reference becomes a single query. The rows where the captured channel and the self-reported source disagree are not noise -- they are a direct measurement of how much your automated capture is missing, and which channels it is missing.

```sql
-- Captured channel versus self-reported source: where they disagree is the
-- size of your dark-traffic blind spot.
SELECT
    a.first_channel  AS captured_channel,
    s.self_reported  AS user_said,
    count(*)         AS users
FROM user_acquisition a
JOIN acquisition_survey s ON s.user_id = a.user_id
GROUP BY a.first_channel, s.self_reported
ORDER BY users DESC;
```

The pattern to watch for is a large cluster of users whose `captured_channel` is `direct` but whose `user_said` names a specific source -- "saw it on a podcast," "a coworker shared it," "found it in a newsletter." That cluster is your dark traffic with a name attached. If a meaningful share of your "direct" signups consistently report the same off-platform source, that is the signal to invest in tagging or measuring that channel directly, even though no referrer or UTM will ever reveal it. Keep the survey field a free-text-friendly select with a small set of options plus an "other" box; rigid dropdowns force users into the wrong bucket and destroy exactly the signal you are trying to capture.

## Building the Dashboard

The queries above are the substance; the dashboard is just their presentation. Whatever tool you point at the `user_acquisition` table -- Grafana with a Postgres data source, Metabase, or a handful of saved queries -- the panels that matter are consistent across SaaS businesses.

- **Signups by first-touch channel over time**, as a stacked area chart, to see which channels are growing or decaying.
- **Channel-to-paid conversion rate**, as a bar chart, ranked by paid conversions rather than signups, so the revenue-producing channels rise to the top regardless of volume.
- **First-touch versus last-touch divergence**, as a matrix, to keep the awareness-versus-conversion gap visible.
- **Campaign breakdown for paid sources**, filtered to the channels you actually spend money on, so cost-per-paid-signup is a number you can compute rather than estimate.

Resist the urge to build forty panels. Four queries answer the questions that drive budget decisions; everything beyond that is usually a distraction from the small number of channels that actually move the business.

### The Two Metrics That Decide Budgets: CAC and Activation by Source

Signups and even paid conversions are leading indicators. The two metrics that a finance conversation actually turns on are **customer acquisition cost (CAC) by channel** -- how much you spend to acquire a paying customer through each channel -- and **activation rate by source** -- whether the users a channel brings in actually reach the moment where your product delivers value. A channel can look cheap on signups and ruinous on CAC, or look productive on signups while delivering users who never activate and churn within a month.

CAC requires one piece of data the schema so far does not have: spend. A small `channel_spend` table, with one row per channel per month, is enough to turn the paid funnel into a cost-per-customer number.

```sql
-- CAC by channel: blended acquisition cost over paying customers acquired,
-- joining a channel_spend table to the paid funnel.
SELECT
    a.first_channel,
    sp.spend_usd,
    count(DISTINCT sub.user_id)                                       AS paid_customers,
    round(sp.spend_usd / nullif(count(DISTINCT sub.user_id), 0), 2)   AS cac_usd
FROM user_acquisition a
JOIN channel_spend sp
       ON sp.channel = a.first_channel
      AND sp.period = date_trunc('month', a.signup_at)
LEFT JOIN subscriptions sub
       ON sub.user_id = a.user_id
      AND sub.status = 'active'
WHERE a.signup_at >= date_trunc('month', now())
GROUP BY a.first_channel, sp.spend_usd
ORDER BY cac_usd NULLS LAST;

-- Activation by source: of users a channel brought in, what fraction reached
-- the activation milestone (here, an 'activated_at' column on users).
SELECT
    a.first_channel,
    count(*)                                                         AS signups,
    count(u.activated_at)                                            AS activated,
    round(100.0 * count(u.activated_at) / nullif(count(*), 0), 1)    AS activation_pct
FROM user_acquisition a
JOIN users u ON u.id = a.user_id
WHERE a.signup_at >= now() - INTERVAL '60 days'
GROUP BY a.first_channel
ORDER BY activation_pct DESC;
```

The CAC query joins spend to paying customers and divides; the `nullif` guards against a divide-by-zero for a channel you spent money on that produced no paying customers yet -- which sorts to the bottom with `NULLS LAST` precisely because it is the most alarming case. The activation query counts users who reached your activation milestone (`activated_at` here stands in for whatever your product's "aha" event is -- created a project, invited a teammate, ran a first job). Read these two together: organic search might show a high CAC of near-zero spend with strong activation, while a paid social campaign shows a defensible CAC but dismal activation, telling you the campaign is buying signups from people the product does not fit. That is the difference between a channel worth scaling and a channel worth cutting, and neither signup volume nor paid conversion alone would have surfaced it.

## A Note on Privacy and GDPR

Acquisition tracking touches personal data, so the compliance posture has to be deliberate rather than an afterthought. Under the GDPR and similar regimes, the referrer, UTM tags, and IP-derived location are personal data when tied to an identifiable user, and you need a lawful basis to process them. The design choices in this post are made with that in mind, and a few principles keep the instrument defensible.

Store the **hash of the IP address, never the raw IP**, and derive only coarse location -- country, not city or network -- from it; the salted hash shown earlier exists precisely so that the raw address is discarded at the moment of capture. Prefer **cookieless, self-hosted analytics** (Plausible, Matomo's cookieless mode) for aggregate reporting so that no consent banner is required for the bulk of your measurement and no data leaves infrastructure you control. **Honor `Do Not Track` and Global Privacy Control** signals in your client-side capture, and treat a privacy-hardened browser as a user who has opted out rather than a measurement problem to defeat. Apply a **retention limit** to per-user acquisition data -- the 90-day attribution window in the schema is also a natural retention boundary -- and let the `ON DELETE CASCADE` carry acquisition records out of the database automatically when a user is deleted or exercises their right to erasure. Finally, **document what you capture and why** in your privacy policy; the entire approach here is defensible specifically because it captures the minimum needed to answer "where do users come from" and nothing more. None of this is legal advice, and a regulated business should have counsel review the specifics, but minimizing what you collect and owning where it lives makes the compliance conversation far shorter.

### Lawful Basis, Consent, and Where the Line Sits

The reason this design is defensible is not that it avoids personal data -- it does not entirely -- but that it draws a clean line between two kinds of processing with different legal footing. Aggregate, cookieless analytics that retain no identifier can often run under **legitimate interest** with no consent banner, because there is no personal data being stored and nothing for the user to consent to. The per-user acquisition record attached to an account is different: it is personal data, but it is processed as part of providing and improving a service the user has signed up for, and you minimize it deliberately. Where exactly the line falls between legitimate interest and required consent depends on jurisdiction and on the specifics of what you store, which is the part a lawyer earns their fee on.

A few engineering practices keep you on the defensible side of that line regardless of how it is ultimately drawn. **Capture acquisition data without a cross-site cookie wherever possible** -- the first-party cookie in the robust capture is a single-domain memory of where this browser first found you, not a tracking cookie shared across sites, which is a category most consent regimes treat very differently. **Tie sensitive enrichment to the signup**, an explicit affirmative action by the user, rather than tracking anonymous visitors with persistent identifiers across the whole marketing site. **Make deletion total and automatic**, which the `ON DELETE CASCADE` across `user_acquisition`, `acquisition_touches`, and `acquisition_survey` already guarantees -- a right-to-erasure request becomes a single user delete, not a hunt across analytics systems you do not fully control. And **expire anonymous data aggressively**: a touch in `acquisition_touches` that never linked to a user has no value after the attribution window and should be deleted on a schedule, which both shrinks your liability surface and keeps the table fast.

The throughline is data minimization as an architecture, not a policy. Every design choice here -- separate table, hashed IP, country-only location, cascading deletes, aggressive expiry of anonymous rows, cookieless aggregate analytics -- exists so that the answer to "what personal data do you hold and why" is short, specific, and easy to honor when someone asks you to forget them.

## Conclusion

Knowing where your users come from is an engineering capability, not a marketing dashboard you buy. The teams that can answer the question precisely are the ones that captured the signal at the source, stored it next to the user, and kept the raw inputs so the attribution model stayed a query they could change rather than a decision they were stuck with.

- **Capture acquisition signal at the conversion moment**, both client-side (first-touch in `localStorage`, last-touch in `sessionStorage`) and server-side (the `Referer` header, a salted IP hash, the user agent), so blocked or forged client data does not leave you blind.
- **Store acquisition data in its own table keyed to the user**, with `ON DELETE CASCADE`, so it joins cleanly to revenue and disappears cleanly on deletion.
- **Keep first-touch and last-touch separately**, and watch the divergence between them, because crediting only one channel will systematically defund the other half of your funnel.
- **Rank channels by paid conversion, not signup volume**, since the channel that produces the most free accounts is frequently not the one that produces the most revenue.
- **Decide budgets on CAC and activation by source**, not on signup or even paid-conversion counts, because a channel can be cheap on signups and ruinous on cost-per-customer, or productive on signups while delivering users who never activate.
- **Decouple enrichment from the signup request** with a queue and an idempotent upsert once GeoIP latency or replayability matters, so slow or failing enrichment never adds latency to -- or rolls back -- account creation.
- **Retain the raw touch log** if you want multi-touch attribution, so switching between first-touch, last-touch, position-based, and time-decay models is a SQL change rather than a re-instrumentation.
- **Use self-hosted, privacy-respecting analytics** (Plausible, PostHog behind a first-party reverse proxy, or Matomo) for aggregate reporting, which both improves capture on technical audiences and shortens the compliance story; keep GA4 only where an external team demands it or self-hosting genuinely cannot be operated.
- **Reject self-referrals and widen the parameter set** in client capture, so internal navigation never pollutes the referral channel and partner or paid-social links are not flattened into "direct" for want of a recognized identifier.
- **Treat the "direct" bucket as a measurement gap, not a channel**, tag every link you control, capture landing pages, and add a one-question "How did you hear about us?" survey to catch the dark traffic instrumentation cannot see.
- **Design for privacy from the start**: hash IPs, honor opt-out signals, limit retention, and collect only what answers the question.
