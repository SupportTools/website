// Progressive enhancement for article pages: Copy buttons on code blocks and
// scroll-spy for the sidebar table of contents.

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

async function copyBlock(block, button, status) {
  let ok = false;
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(codeTextFrom(block));
    ok = true;
  } catch {
    ok = false;
  }
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

function init() {
  enhanceCodeBlocks();
  enhanceToc();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
