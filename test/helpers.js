import { createApi } from '../src/api.js';
import { createD1 } from './d1-shim.js';

export const HOUR = 3600 * 1000;
export const ORIGIN = 'https://locutus75.github.io';

export function setup({ allowedOrigins = `${ORIGIN},http://localhost:3100` } = {}) {
  let clock = Date.parse('2026-01-01T12:00:00Z');
  const api = createApi({ now: () => clock });
  const env = { DB: createD1(), ALLOWED_ORIGINS: allowedOrigins };

  /** A client that remembers its session token, like a browser tab. */
  function client() {
    let token = null;
    return async function call(method, url, body) {
      const headers = { Origin: ORIGIN };
      if (token) headers.Authorization = `Bearer ${token}`;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await api.fetch(new Request('https://api.test' + url, { method, headers, body: payload }), env);
      const data = res.headers.get('Content-Type')?.includes('json') ? await res.json() : await res.arrayBuffer();
      if (data && data.token) token = data.token;
      return { status: res.status, data, headers: res.headers };
    };
  }

  return { api, env, client, advance: (ms) => (clock += ms), now: () => clock };
}
