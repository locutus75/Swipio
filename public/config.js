// Where the Swipio API (the Cloudflare Worker) lives, without a trailing slash.
// Empty means "same site as this page", which is what `npm run dev` uses.
// The GitHub Pages deploy overwrites this file with the deployed Worker's URL.
window.SWIPIO_CONFIG = Object.assign({
  apiUrl: '',
}, window.SWIPIO_CONFIG || {});
