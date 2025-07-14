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
      
      // Serve static assets
      const response = await env.ASSETS.fetch(request);
      
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