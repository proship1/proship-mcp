// Shared test helpers: JSON-RPC inject wrapper + fetch stubbing.

export const realFetch = globalThis.fetch;

export function stubFetch(responses) {
  // responses: array of {status, body} consumed in order (last repeats)
  let i = 0;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), {
      status: r.status, headers: { 'Content-Type': 'application/json' }
    });
  };
  return calls;
}

export async function rpc(app, body, headers = {}) {
  return app.inject({
    method: 'POST', url: '/mcp',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
}
