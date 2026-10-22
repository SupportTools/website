// Progressive enhancement: Copy buttons on code blocks, scroll-spy for the
// sidebar table of contents, the search query kept in the page URL, and the
// article_read and code_copied analytics events.

const COPIED_MS = 2000;

export function statusText(ok) {
  return ok ? 'Copied to clipboard' : 'Copy failed, select the code manually';
}

// The exact source text of a code block, without line numbers.
export function codeTextFrom(root) {
  const cells = root.querySelectorAll('td.lntd');
  const code = cells.length
    ? cells[cells.length - 1].querySelector('code')
    : root.querySelector('pre code');
  if (!code) return '';
  const clone = code.cloneNode(true);
  clone.querySelectorAll('.ln').forEach((ln) => ln.remove());
  return clone.textContent.replace(/\n$/, '');
}

// Sends an event to PostHog when it loaded (an ad blocker may stop it).
// Returns whether it did. Never throws.
export function track(event, props) {
  try {
    const ph = typeof window !== 'undefined' ? window.posthog : undefined;
    if (!ph || typeof ph.capture !== 'function') return false;
    ph.capture(event, props);
    return true;
  } catch {
    return false;
  }
}

async function copyBlock(block, button, status) {
  let ok = false;
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(codeTextFrom(block));
    ok = true;
  } catch {
    ok = false;
  }
  if (ok) track('code_copied');
  clearTimeout(button.resetTimer);
  button.textContent = ok ? 'Copied' : 'Copy failed';
  if (status) {
    // Clear, then set the text on a later task, so screen readers announce a
    // repeat of the same message.
    status.textContent = '';
    setTimeout(() => {
      status.textContent = statusText(ok);
    }, 100);
  }
  if (ok) {
    button.resetTimer = setTimeout(() => {
      button.textContent = 'Copy';
      if (status) status.textContent = '';
    }, COPIED_MS);
  }
}

function enhanceCodeBlocks() {
  const status = document.getElementById('copy-status');
  document.querySelectorAll('.code-block').forEach((block) => {
    const header = block.querySelector('.code-block-header');
    if (!header || header.querySelector('.code-copy')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.setAttribute('aria-label', block.dataset.copyLabel || 'Copy code');
    button.textContent = 'Copy';
    button.addEventListener('click', () => copyBlock(block, button, status));
    header.appendChild(button);
  });
}

// The active TOC entry: the first heading, in document order, that is in the
// observed band; when none is, the previous entry stays active.
export function pickActive(visibleIds, orderedIds, previous) {
  for (const id of orderedIds) {
    if (visibleIds.has(id)) return id;
  }
  return previous;
}

// Marks the sidebar link for the current section with aria-current. It does
// not move focus, write history, or announce anything.
function enhanceToc() {
  const sidebar = document.querySelector('.toc-sidebar');
  if (!sidebar || typeof IntersectionObserver === 'undefined') return;
  const links = new Map();
  sidebar.querySelectorAll('a[href^="#"]').forEach((link) => {
    const id = decodeURIComponent(link.getAttribute('href').slice(1));
    if (id && document.getElementById(id)) links.set(id, link);
  });
  if (!links.size) return;
  const orderedIds = [...links.keys()];
  const visible = new Set();
  let active = null;
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      });
      const next = pickActive(visible, orderedIds, active);
      if (next === active) return;
      if (active) links.get(active).removeAttribute('aria-current');
      if (next) links.get(next).setAttribute('aria-current', 'location');
      active = next;
    },
    { rootMargin: '0px 0px -70% 0px' },
  );
  orderedIds.forEach((id) => observer.observe(document.getElementById(id)));
}

const SEARCH_DEBOUNCE_MS = 300;

// The search term carried in a URL's q parameter, or '' when there is none.
export function queryFromUrl(href) {
  return new URL(href).searchParams.get('q') || '';
}

// The same-page relative URL with q set to the trimmed query, or with q
// removed when the query is blank. Other parameters and the hash are kept.
export function urlWithQuery(href, query) {
  const url = new URL(href);
  const term = query.trim();
  if (term) url.searchParams.set('q', term);
  else url.searchParams.delete('q');
  return url.pathname + url.search + url.hash;
}

// Keeps ?q= in step with the Pagefind search box: restores the box from the
// URL on load, and rewrites the URL, debounced, as the reader types. The term
// only ever goes into the input's value property and the URL, never into HTML.
async function initSearchUrl() {
  if (!document.querySelector('.search-interface')) return;
  if (typeof customElements === 'undefined') return;
  await customElements.whenDefined('pagefind-input');
  const input = document.querySelector('.search-interface .pf-input');
  if (!input) return;

  const initial = queryFromUrl(location.href);
  if (initial) {
    input.value = initial;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = urlWithQuery(location.href, input.value);
      if (next !== location.pathname + location.search + location.hash) {
        history.replaceState(history.state, '', next);
      }
    }, SEARCH_DEBOUNCE_MS);
  });
}

const READ_RATIO = 0.75;
const READ_VISIBLE_MS = 30000;
const READ_CHECK_MS = 5000;

// The share of the article body, from top to bottom, that has been on screen:
// top is the body's document offset. An empty body counts as read.
export function readRatio(scrollY, viewportH, top, height) {
  if (height <= 0) return 1;
  return Math.min(1, Math.max(0, (scrollY + viewportH - top) / height));
}

// Visible time so far: adds the span since the last update only when the tab
// was visible during it.
export function visibleMs(prevMs, sinceMs, nowMs, hidden) {
  return hidden ? prevMs : prevMs + (nowMs - sinceMs);
}

export function shouldSendRead(ratio, visible, sent) {
  return ratio >= READ_RATIO && visible >= READ_VISIBLE_MS && !sent;
}

// Sends article_read once, after the reader has seen 75% of the body and
// spent 30 s with the tab visible.
function enhanceReadTracking() {
  const body = document.querySelector('.post-content');
  if (!body) return;
  let acc = 0;
  let since = Date.now();
  let maxRatio = 0;
  let sent = false;
  let frame = 0;

  const measure = () => {
    frame = 0;
    const rect = body.getBoundingClientRect();
    maxRatio = Math.max(maxRatio, readRatio(window.scrollY, window.innerHeight, rect.top + window.scrollY, rect.height));
  };
  const elapsed = () => visibleMs(acc, since, Date.now(), document.hidden);

  document.addEventListener('visibilitychange', () => {
    // The tab was visible until it hid, and hidden until it showed again.
    acc = visibleMs(acc, since, Date.now(), !document.hidden);
    since = Date.now();
  });
  window.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(measure);
  }, { passive: true });

  const check = () => {
    if (!shouldSendRead(maxRatio, elapsed(), sent)) return;
    sent = true;
    clearInterval(timer);
    track('article_read', {
      read_ratio: Math.round(maxRatio * 100) / 100,
      visible_seconds: Math.round(elapsed() / 1000),
    });
  };
  const timer = setInterval(check, READ_CHECK_MS);
  measure();
}

function init() {
  enhanceCodeBlocks();
  enhanceToc();
  initSearchUrl();
  enhanceReadTracking();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
