// Cloudflare Worker entry point. /api/* goes to the API; everything else is served from public/
// (handy for local development and as a fallback host; production uses GitHub Pages).
import { createApi } from './api.js';

const api = createApi();

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api.fetch(request, env);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
  // Cron trigger: closes expired collections even when nobody is using the app.
  scheduled(event, env, ctx) {
    ctx.waitUntil(api.scheduled(event, env));
  },
};
