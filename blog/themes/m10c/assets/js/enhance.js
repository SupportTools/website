// Progressive enhancement for article pages: Copy buttons on code blocks.

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
    status.textContent = '';
    status.textContent = statusText(ok);
  }
  if (ok) {
    button.resetTimer = setTimeout(() => {
      button.textContent = 'Copy';
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

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceCodeBlocks);
  } else {
    enhanceCodeBlocks();
  }
}
