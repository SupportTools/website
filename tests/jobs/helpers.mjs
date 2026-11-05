// Shared test plumbing: fail-closed fetch and a scoped environment. Nothing in
// tests/jobs reaches the network; a fetch no test routed throws.
export function failClosedFetch() {
  globalThis.fetch = async (url) => { throw new Error(`unmocked fetch ${url}`); };
}

export function saveEnv(keys) {
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

// Routes fetches by predicate; records every call as { url, init, body }.
export function routeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* raw */ } }
    const call = { url: u, init, body };
    calls.push(call);
    const r = await handler(call, calls);
    if (!r) throw new Error(`unmocked fetch ${init.method || 'GET'} ${u}`);
    return r;
  };
  return calls;
}

// A Messages API response.
export function message({ content, stop_reason = 'end_turn', usage = { input_tokens: 1000, output_tokens: 200 }, model = 'claude-haiku-5-5' }) {
  return json({ id: `msg_${Math.random().toString(36).slice(2)}`, type: 'message', role: 'assistant', model, content, stop_reason, usage });
}

// True for a Messages API request (exact origin and path, not a prefix match).
export function isMessagesApi(url) {
  const u = new URL(url);
  return u.origin === 'https://api.anthropic.com' && u.pathname === '/v1/messages';
}
