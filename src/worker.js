import CATEGORY_REDIRECTS from './category-redirects.json' with { type: 'json' };

const AGENT_POLICY = 'ai-train=no, search=yes, ai-input=yes';

function addDiscoveryHeaders(response) {
  const headers = new Headers(response.headers);
  const vary = headers.get('vary');
  headers.set('vary', vary ? `${vary}, Accept` : 'Accept');
  headers.set('content-signal', AGENT_POLICY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function markdownAssetPath(pathname) {
  if (pathname.endsWith('/')) return `${pathname}index.md`;
  if (pathname.endsWith('.html')) return pathname.replace(/\.html$/, '.md');
  if (!pathname.split('/').pop().includes('.')) return `${pathname}/index.md`;
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);
    
    try {
      // Log incoming request
      console.log(`${request.method} ${url.pathname} - ${request.headers.get('cf-connecting-ip') || 'unknown'} - ${request.headers.get('user-agent')}`);
      
      // Handle health check endpoints
      if (url.pathname === '/healthz') {
        const response = new Response('OK', { 
          status: 200,
          headers: { 'content-type': 'text/plain' }
        });
        console.log(`Health check completed in ${Date.now() - startTime}ms`);
        return response;
      }
      
      if (url.pathname === '/version') {
        const response = new Response(JSON.stringify({
          version: 'cloudflare-workers',
          buildTime: new Date().toISOString(),
          platform: 'cloudflare-workers'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
        console.log(`Version endpoint completed in ${Date.now() - startTime}ms`);
        return response;
      }
      
      // The homepage feed moved to /archive/; keep old paginated URLs working.
      const legacyPage = url.pathname.match(/^\/page\/(\d+)\/?$/);
      if ((request.method === 'GET' || request.method === 'HEAD') && legacyPage) {
        return Response.redirect(`${url.origin}/archive/page/${legacyPage[1]}/`, 301);
      }

      // Categories merged in 2f953d21 (canonical taxonomy); send old term pages,
      // their pagination and feeds to the category they were merged into.
      const oldCategory = url.pathname.match(/^\/categories\/([^/]+)\//);
      if ((request.method === 'GET' || request.method === 'HEAD') && oldCategory
          && Object.hasOwn(CATEGORY_REDIRECTS, oldCategory[1])) {
        return Response.redirect(`${url.origin}/categories/${CATEGORY_REDIRECTS[oldCategory[1]]}/`, 301);
      }

      // Serve the Hugo-generated Markdown representation to clients that ask
      // for it, while preserving the canonical HTML URL.
      const acceptsMarkdown = request.headers.get('accept')?.includes('text/markdown');
      if ((request.method === 'GET' || request.method === 'HEAD') && acceptsMarkdown) {
        const markdownPath = markdownAssetPath(url.pathname);
        if (markdownPath) {
          const markdownUrl = new URL(request.url);
          markdownUrl.pathname = markdownPath;
          const markdownResponse = await env.ASSETS.fetch(new Request(markdownUrl, request));
          if (markdownResponse.ok) {
            const headers = new Headers(markdownResponse.headers);
            headers.set('content-type', 'text/markdown; charset=utf-8');
            return addDiscoveryHeaders(new Response(markdownResponse.body, {
              status: markdownResponse.status,
              statusText: markdownResponse.statusText,
              headers,
            }));
          }
        }
      }

      // Serve static assets.
      const response = addDiscoveryHeaders(await env.ASSETS.fetch(request));
      
      // Log response details
      const duration = Date.now() - startTime;
      console.log(`${request.method} ${url.pathname} - ${response.status} - ${duration}ms - ${response.headers.get('content-length') || 0} bytes`);
      
      return response;
      
    } catch (error) {
      console.error(`Worker error for ${url.pathname}:`, error.message, error.stack);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
