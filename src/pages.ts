export const escape = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

export const FONT_ROUTE = "/__fleet/assets/geist-pixel-square.woff2";

export interface GateAppView {
  name: string;
  url: string;
  running: boolean;
  building?: boolean;
  error?: string | null;
  peer?: string;
  online?: boolean;
}

export interface PageOptions {
  brandHref?: string;
  showLogout?: boolean;
  centered?: boolean;
  fontUrl?: string;
  script?: string;
}

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none"><rect width="40" height="40" rx="10" fill="#0e0e0e"/><g shape-rendering="crispEdges"><path fill="#33175c" d="M22.7 13.25h1.35v1.35h-1.35zM13.25 20h2.7v1.35h-2.7zM18.65 20h1.35v1.35h-1.35zM24.05 20h2.7v1.35h-2.7zM14.6 21.35h4.05v1.35h-4.05zM25.4 21.35h1.35v1.35h-1.35zM14.6 22.7h2.7v1.35h-2.7zM18.65 22.7h1.35v1.35h-1.35zM21.35 22.7h1.35v1.35h-1.35zM24.05 22.7h1.35v1.35h-1.35zM14.6 24.05h1.35v1.35h-1.35zM20 24.05h1.35v1.35h-1.35zM22.7 24.05h2.7v1.35h-2.7zM15.95 25.4h1.35v1.35h-1.35zM18.65 25.4h5.4v1.35h-5.4zM17.3 26.75h1.35v1.35h-1.35zM20 26.75h1.35v1.35h-1.35zM22.7 26.75h1.35v1.35h-1.35zM17.3 28.1h2.7v1.35h-2.7zM21.35 28.1h1.35v1.35h-1.35zM20 29.45h1.35v1.35h-1.35z"/><path fill="#6d3fd1" d="M20 7.85h1.35v1.35h-1.35zM17.3 10.55h1.35v1.35h-1.35zM21.35 10.55h1.35v1.35h-1.35zM18.65 11.9h1.35v1.35h-1.35zM15.95 14.6h1.35v1.35h-1.35zM18.65 14.6h1.35v1.35h-1.35zM24.05 15.95h1.35v1.35h-1.35zM13.25 17.3h1.35v1.35h-1.35zM25.4 17.3h1.35v1.35h-1.35zM14.6 18.65h1.35v1.35h-1.35zM17.3 18.65h1.35v1.35h-1.35zM20 18.65h1.35v1.35h-1.35zM22.7 18.65h1.35v1.35h-1.35zM25.4 18.65h1.35v1.35h-1.35zM15.95 20h2.7v1.35h-2.7zM20 20h4.05v1.35h-4.05zM13.25 21.35h1.35v1.35h-1.35zM18.65 21.35h6.75v1.35h-6.75zM17.3 22.7h1.35v1.35h-1.35zM20 22.7h1.35v1.35h-1.35zM22.7 22.7h1.35v1.35h-1.35zM15.95 24.05h4.05v1.35h-4.05zM21.35 24.05h1.35v1.35h-1.35zM17.3 25.4h1.35v1.35h-1.35zM15.95 26.75h1.35v1.35h-1.35zM18.65 26.75h1.35v1.35h-1.35zM21.35 26.75h1.35v1.35h-1.35zM20 28.1h1.35v1.35h-1.35zM17.3 29.45h2.7v1.35h-2.7zM21.35 29.45h1.35v1.35h-1.35zM18.65 30.8h2.7v1.35h-2.7zM20 32.15h1.35v1.35h-1.35z"/><path fill="#a873fa" d="M18.65 7.85h1.35v1.35h-1.35zM18.65 9.2h2.7v1.35h-2.7zM18.65 10.55h2.7v1.35h-2.7zM17.3 11.9h1.35v1.35h-1.35zM20 11.9h2.7v1.35h-2.7zM15.95 13.25h1.35v1.35h-1.35zM18.65 13.25h4.05v1.35h-4.05zM14.6 14.6h1.35v1.35h-1.35zM20 14.6h2.7v1.35h-2.7zM14.6 15.95h9.45v1.35h-9.45zM14.6 17.3h10.8v1.35h-10.8zM15.95 18.65h1.35v1.35h-1.35zM18.65 18.65h1.35v1.35h-1.35zM21.35 18.65h1.35v1.35h-1.35zM24.05 18.65h1.35v1.35h-1.35zM18.65 32.15h1.35v1.35h-1.35z"/><path fill="#e6d1ff" d="M17.3 13.25h1.35v1.35h-1.35zM17.3 14.6h1.35v1.35h-1.35zM22.7 14.6h1.35v1.35h-1.35zM13.25 18.65h1.35v1.35h-1.35z"/></g></svg>';

const FAVICON_URI = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

// Purple dithered Plumbob + Fleet wordmark, optically balanced and tightly framed.
const BRAND_WORDMARK_SVG = `<svg class="brand-svg" xmlns="http://www.w3.org/2000/svg" viewBox="2 3.5 75 25" fill="none" aria-label="Fleet"><g shape-rendering="crispEdges" transform="translate(9.5 16) scale(1.28) translate(-9.5 -16)"><path fill="#33175c" d="M5.8 16h1.06v1.06h-1.06zM7.92 16h1.06v1.06h-1.06zM13.22 16h1.06v1.06h-1.06zM5.8 17.06h2.12v1.06h-2.12zM8.98 17.06h1.06v1.06h-1.06zM11.1 17.06h1.06v1.06h-1.06zM13.22 17.06h1.06v1.06h-1.06zM6.86 18.12h1.06v1.06h-1.06zM12.16 18.12h1.06v1.06h-1.06zM6.86 19.18h1.06v1.06h-1.06zM8.98 19.18h1.06v1.06h-1.06zM11.1 19.18h2.12v1.06h-2.12zM7.92 20.24h1.06v1.06h-1.06zM10.04 20.24h1.06v1.06h-1.06zM7.92 21.3h4.24v1.06h-4.24z"/><path fill="#6d3fd1" d="M7.92 9.64h1.06v1.06h-1.06zM11.1 9.64h1.06v1.06h-1.06zM8.98 10.7h1.06v1.06h-1.06zM12.16 11.76h1.06v1.06h-1.06zM6.86 12.82h1.06v1.06h-1.06zM13.22 13.88h1.06v1.06h-1.06zM4.74 14.94h1.06v1.06h-1.06zM6.86 14.94h3.18v1.06h-3.18zM11.1 14.94h1.06v1.06h-1.06zM13.22 14.94h1.06v1.06h-1.06zM4.74 16h1.06v1.06h-1.06zM6.86 16h1.06v1.06h-1.06zM8.98 16h4.24v1.06h-4.24zM7.92 17.06h1.06v1.06h-1.06zM10.04 17.06h1.06v1.06h-1.06zM12.16 17.06h1.06v1.06h-1.06zM5.8 18.12h1.06v1.06h-1.06zM7.92 18.12h4.24v1.06h-4.24zM7.92 19.18h1.06v1.06h-1.06zM10.04 19.18h1.06v1.06h-1.06zM8.98 20.24h1.06v1.06h-1.06zM10.04 22.36h1.06v1.06h-1.06zM8.98 23.42h1.06v1.06h-1.06z"/><path fill="#a873fa" d="M8.98 8.58h2.12v1.06h-2.12zM8.98 9.64h2.12v1.06h-2.12zM7.92 10.7h1.06v1.06h-1.06zM10.04 10.7h2.12v1.06h-2.12zM6.86 11.76h1.06v1.06h-1.06zM8.98 11.76h3.18v1.06h-3.18zM8.98 12.82h3.18v1.06h-3.18zM5.8 13.88h7.42v1.06h-7.42zM10.04 14.94h1.06v1.06h-1.06zM12.16 14.94h1.06v1.06h-1.06zM11.1 20.24h1.06v1.06h-1.06zM8.98 22.36h1.06v1.06h-1.06zM10.04 23.42h1.06v1.06h-1.06z"/><path fill="#e6d1ff" d="M8.98 7.52h1.06v1.06h-1.06zM7.92 11.76h1.06v1.06h-1.06zM7.92 12.82h1.06v1.06h-1.06zM12.16 12.82h1.06v1.06h-1.06zM5.8 14.94h1.06v1.06h-1.06z"/><path class="shimmer s1" fill="#e6d1ff" d="M8.98 10.7h1.06v1.06h-1.06zM5.8 13.88h1.06v1.06h-1.06zM7.92 13.88h2.12v1.06h-2.12zM11.1 13.88h1.06v1.06h-1.06zM11.1 17.06h2.12v1.06h-2.12zM8.98 20.24h1.06v1.06h-1.06zM11.1 20.24h1.06v1.06h-1.06zM10.04 23.42h1.06v1.06h-1.06z"/><path class="shimmer s2" fill="#e6d1ff" d="M7.92 9.64h3.18v1.06h-3.18zM6.86 12.82h1.06v1.06h-1.06zM8.98 12.82h1.06v1.06h-1.06zM11.1 12.82h1.06v1.06h-1.06zM6.86 16h2.12v1.06h-2.12zM10.04 16h1.06v1.06h-1.06zM12.16 16h2.12v1.06h-2.12zM10.04 19.18h1.06v1.06h-1.06zM8.98 22.36h2.12v1.06h-2.12z"/><path class="shimmer s3" fill="#e6d1ff" d="M10.04 11.76h1.06v1.06h-1.06zM12.16 11.76h1.06v1.06h-1.06zM4.74 14.94h1.06v1.06h-1.06zM7.92 14.94h1.06v1.06h-1.06zM11.1 14.94h3.18v1.06h-3.18zM6.86 18.12h1.06v1.06h-1.06zM10.04 18.12h1.06v1.06h-1.06zM7.92 21.3h3.18v1.06h-3.18z"/></g><path fill="currentColor" d="M25.91 24.5L25.91 10.9Q25.91 9.14 26.88 8.12Q27.85 7.11 29.93 7.11L32.48 7.11L32.48 9.53L30.52 9.53Q29.76 9.53 29.4 9.92Q29.05 10.31 29.05 11.07L29.05 24.5ZM24.05 13.84L24.05 11.42L32.31 11.42L32.31 13.84ZM37.31 24.5Q35.89 24.5 35.03 23.77Q34.18 23.03 34.18 21.41L34.18 7.11L37.31 7.11L37.31 21.09Q37.31 21.58 37.57 21.83Q37.83 22.07 38.29 22.07L39.25 22.07L39.25 24.5ZM46.26 24.79Q44.3 24.79 42.86 23.95Q41.41 23.1 40.63 21.56Q39.84 20.02 39.84 17.96Q39.84 15.9 40.63 14.37Q41.41 12.84 42.84 11.98Q44.28 11.12 46.19 11.12Q48.05 11.12 49.46 11.96Q50.87 12.79 51.63 14.36Q52.39 15.92 52.39 18.13L52.39 18.84L43.1 18.84Q43.2 20.56 44.04 21.43Q44.89 22.3 46.29 22.3Q47.34 22.3 48.04 21.82Q48.74 21.34 49.01 20.48L52.22 20.68Q51.68 22.59 50.1 23.69Q48.52 24.79 46.26 24.79ZM43.1 16.73L49.15 16.73Q49.05 15.14 48.25 14.37Q47.44 13.6 46.19 13.6Q44.94 13.6 44.12 14.41Q43.3 15.21 43.1 16.73ZM59.89 24.79Q57.93 24.79 56.49 23.95Q55.04 23.1 54.26 21.56Q53.47 20.02 53.47 17.96Q53.47 15.9 54.26 14.37Q55.04 12.84 56.47 11.98Q57.91 11.12 59.82 11.12Q61.68 11.12 63.09 11.96Q64.5 12.79 65.26 14.36Q66.02 15.92 66.02 18.13L66.02 18.84L56.73 18.84Q56.83 20.56 57.67 21.43Q58.52 22.3 59.92 22.3Q60.97 22.3 61.67 21.82Q62.37 21.34 62.64 20.48L65.84 20.68Q65.31 22.59 63.73 23.69Q62.15 24.79 59.89 24.79ZM56.73 16.73L62.78 16.73Q62.68 15.14 61.88 14.37Q61.07 13.6 59.82 13.6Q58.57 13.6 57.75 14.41Q56.93 15.21 56.73 16.73ZM73.1 24.5Q71.14 24.5 70.23 23.59Q69.31 22.69 69.31 20.75L69.31 8.35L72.44 8.35L72.44 20.46Q72.44 21.36 72.83 21.72Q73.23 22.07 74.06 22.07L75.9 22.07L75.9 24.5ZM67.25 13.84L67.25 11.42L75.9 11.42L75.9 13.84Z"/></svg>`;

const ROW_ARROW_SVG =
  '<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12M9.5 3.5 14 8l-4.5 4.5"/></svg>';

// Bayer 4x4 violet dither tile used for subtle row hover sheen (echoing web/components/landing.tsx).
const DITHER_TILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="2" height="2" fill="#a873fa" opacity=".36"/><rect x="4" y="4" width="2" height="2" fill="#a873fa" opacity=".36"/><rect x="4" width="2" height="2" fill="#6d3fd1" opacity=".24"/><rect y="4" width="2" height="2" fill="#6d3fd1" opacity=".24"/></svg>';

const DITHER_TILE_URI = `data:image/svg+xml,${encodeURIComponent(DITHER_TILE_SVG)}`;

export function buildStyle(fontUrl = FONT_ROUTE): string {
  return `@font-face{font-family:"Geist Pixel Square";src:url("${fontUrl}") format("woff2");font-weight:400;font-style:normal;font-display:swap}
:root{
  color-scheme:dark light;
  --bg:#090909;
  --fg:#f0f0f0;
  --input:#141416;
  --muted:rgba(255,255,255,.64);
  --dim:rgba(255,255,255,.46);
  --border:rgba(255,255,255,.11);
  --border-strong:rgba(255,255,255,.20);
  --violet:#a873fa;
  --violet-ring:rgba(168,115,250,.28);
  --btn-bg:#f0f0f0;
  --btn-fg:#090909;
  --ok:#4ade80;
  --warn:#fbbf24;
  --err:#f87171;
  --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  --font-heading:"Geist Pixel Square",var(--font-sans);
  --font-mono:ui-monospace,"SFMono-Regular",Menlo,Monaco,Consolas,monospace;
  background:var(--bg);
  color:var(--fg);
  font:16px/1.6 var(--font-sans);
  -webkit-font-smoothing:antialiased;
}
@media(prefers-color-scheme:light){
  :root{
    --bg:#fafafa;
    --fg:#0a0a0a;
    --input:#f3f3f5;
    --muted:rgba(10,10,10,.64);
    --dim:rgba(10,10,10,.48);
    --border:rgba(10,10,10,.11);
    --border-strong:rgba(10,10,10,.20);
    --violet:#6d3fd1;
    --violet-ring:rgba(109,63,209,.22);
    --btn-bg:#111111;
    --btn-fg:#fafafa;
    --ok:#15803d;
    --warn:#b45309;
    --err:#dc2626;
  }
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;min-height:100%;background:var(--bg);color:var(--fg);overflow-x:clip}
main{max-width:640px;margin:0 auto;padding:48px 24px 72px}
.centered-body{min-height:100vh;display:flex;align-items:center;justify-content:center}
.centered-body main{width:100%;max-width:560px;padding:32px 24px;text-align:center;display:flex;flex-direction:column;align-items:center}
.centered-body .topbar{justify-content:center;margin-bottom:32px}
.centered-body p{margin-inline:auto}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:52px}
.brand{display:inline-flex;align-items:center;color:var(--fg);text-decoration:none;border-radius:6px}
.brand:focus-visible{outline:2px solid var(--violet);outline-offset:4px}
.brand-svg{display:block;height:38px;width:auto}
h1{margin:0 0 16px;font-family:var(--font-heading);font-size:clamp(32px,5.6vw,48px);font-weight:400;line-height:1.12;letter-spacing:-.02em;color:var(--fg)}
h1 span{color:var(--muted)}
p{margin:0;font-size:16px;color:var(--muted);max-width:50ch}
p+p{margin-top:12px}
a{color:inherit;text-underline-offset:4px}
code{font-family:var(--font-mono);font-size:16px;padding:1px 7px;border-radius:6px;background:var(--input);border:1px solid var(--border);color:var(--fg);overflow-wrap:anywhere}
h1 .app-code{font-family:var(--font-mono);font-size:.82em;line-height:1;padding:3px 11px;border-radius:8px;background:var(--input);border:1px solid var(--border-strong);color:var(--fg);vertical-align:.04em}
.login-form{margin-top:28px}
input,textarea{display:block;width:100%;background:var(--input);border:1px solid var(--border-strong);border-radius:8px;padding:13px 16px;color:var(--fg);font:inherit;font-size:16px;transition:border-color .15s,box-shadow .15s}
input:focus,textarea:focus{outline:none;border-color:var(--violet);box-shadow:0 0 0 3px var(--violet-ring)}
.code-input{font-family:var(--font-mono);font-size:18px;letter-spacing:.14em;text-transform:uppercase}
.code-input::placeholder{color:var(--dim);letter-spacing:.14em}
.actions{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:20px}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 20px;border:1px solid transparent;border-radius:8px;background:var(--btn-bg);color:var(--btn-fg);font:inherit;font-size:16px;font-weight:500;cursor:pointer;text-decoration:none;transition:opacity .15s,background-color .15s;white-space:nowrap}
button:hover,.button:hover{opacity:.88}
button:focus-visible,.button:focus-visible{outline:2px solid var(--violet);outline-offset:3px}
.signout{height:auto;padding:8px 0;background:none;border:0;color:var(--muted);font-size:16px;font-weight:400;border-radius:4px}
.signout:hover{opacity:1;color:var(--fg)}
.text-link,.text-btn{display:inline-flex;align-items:center;gap:6px;height:44px;padding:0 4px;background:none;border:0;font-size:16px;font-weight:400;color:var(--muted);text-decoration:none;cursor:pointer;transition:color .15s}
.text-link:hover,.text-btn:hover{opacity:1;color:var(--fg)}
.text-link:focus-visible,.text-btn:focus-visible{outline:2px solid var(--violet);outline-offset:4px;border-radius:4px}
.error{margin-top:20px;font-size:16px;color:var(--err)}
.app-list{margin:32px 0 0;padding:0;list-style:none;border-top:1px solid var(--border)}
.app-row{position:relative;isolation:isolate;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:16px;min-height:64px;padding:14px 6px;border-bottom:1px solid var(--border);text-decoration:none;color:inherit}
.app-row::before{content:"";position:absolute;inset:0;z-index:-1;opacity:0;transition:opacity .25s;background-image:url("${DITHER_TILE_URI}"),linear-gradient(to left,rgba(168,115,250,.15),transparent 78%);background-size:8px 8px,100% 100%;image-rendering:pixelated;-webkit-mask-image:linear-gradient(to right,transparent 16%,rgba(0,0,0,.35) 52%,#000 96%);mask-image:linear-gradient(to right,transparent 16%,rgba(0,0,0,.35) 52%,#000 96%)}
.app-row:hover::before,.app-row:focus-visible::before{opacity:.85}
.app-row:focus-visible{outline:2px solid var(--violet);outline-offset:-2px;border-radius:4px}
.app-name{font-size:18px;font-weight:500;letter-spacing:-.01em;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.app-status{display:inline-flex;align-items:center;gap:12px;font-family:var(--font-mono);font-size:16px;white-space:nowrap}
.state{display:inline-flex;align-items:center;gap:7px;color:var(--dim)}
.state-glyph{font-size:18px;line-height:1}
.state.tone-ok{color:var(--ok)}
.state.tone-violet{color:var(--violet)}
.state.tone-warn{color:var(--warn)}
.state.tone-err{color:var(--err)}
.arrow{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;flex:none;color:var(--dim);transition:color .15s,transform .18s}
.app-row:hover .arrow,.app-row:focus-visible .arrow{color:var(--fg);transform:translateX(3px)}
.empty{margin-top:32px;padding-top:24px;border-top:1px solid var(--border)}
.wiz-bars{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:32px}
.wiz-bar{height:4px;padding:0;border:0;border-radius:999px;background:var(--border);cursor:pointer;transition:background-color .2s,opacity .2s}
.wiz-bar[data-state="done"]{background:var(--violet);opacity:.45}
.wiz-bar[data-state="active"]{background:var(--violet);opacity:1}
.wiz-bar:hover{opacity:.85}
.wiz-step{display:flex;flex-direction:column;align-items:flex-start}
.wiz-step[hidden]{display:none}
.wiz-step h1{font-size:clamp(28px,5.2vw,42px);margin-bottom:18px}
.wiz-step .actions{margin-top:24px}
.status-line{margin-top:20px;font-family:var(--font-mono);font-size:16px;color:var(--err)}
.dot{display:inline-block;width:13px;height:13px;border-radius:50%;background:var(--violet);margin-right:14px;vertical-align:.1em;animation:pulse 1.2s ease-in-out infinite}
.shimmer{opacity:0;animation:shimmer 2.4s steps(2,end) infinite}
.s2{animation-delay:-.8s}
.s3{animation-delay:-1.6s}
@keyframes shimmer{0%,100%{opacity:0}50%{opacity:.78}}
@keyframes pulse{50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){.dot,.shimmer{animation:none}.shimmer{opacity:0}}
@media(max-width:560px){
  main{padding:28px 18px 56px}
  .topbar{margin-bottom:36px}
  .brand-svg{height:34px}
  .app-row{grid-template-columns:minmax(0,1fr) auto;padding:14px 2px}
  .app-status{grid-column:1;margin-top:2px;flex-wrap:wrap}
  .app-row .arrow{grid-column:2;grid-row:1 / span 2}
}`;
}

export const style = buildStyle();

function renderTopbar(options: PageOptions): string {
  const brand = options.brandHref
    ? `<a class="brand" href="${escape(options.brandHref)}">${BRAND_WORDMARK_SVG}</a>`
    : `<span class="brand">${BRAND_WORDMARK_SVG}</span>`;
  const logout = options.showLogout
    ? '<form method="post" action="/__fleet/logout"><button class="signout" type="submit">Sign out</button></form>'
    : "";
  return `<header class="topbar">${brand}${logout}</header>`;
}

export function page(
  title: string,
  body: string,
  scriptOrOptions: string | PageOptions = "",
): string {
  const options: PageOptions =
    typeof scriptOrOptions === "string" ? { script: scriptOrOptions } : scriptOrOptions;
  const css = options.fontUrl ? buildStyle(options.fontUrl) : style;
  const script = options.script || "";
  const bodyClass = options.centered ? ' class="centered-body"' : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><meta name="theme-color" content="#090909" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)"><link rel="icon" type="image/svg+xml" href="${FAVICON_URI}"><title>${escape(title)} · Fleet</title><style>${css}</style></head><body${bodyClass}><main>${renderTopbar(options)}${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

function renderAppRow(app: GateAppView): string {
  let glyph = "○";
  let label = "Ready on demand";
  let tone = "";
  if (app.peer && app.online === false) {
    glyph = "◇";
    label = "Offline";
    tone = " tone-warn";
  } else if (app.building) {
    glyph = "◐";
    label = "Building";
    tone = " tone-violet";
  } else if (app.running) {
    glyph = "●";
    label = "Running";
    tone = " tone-ok";
  }
  const errorNote = app.error
    ? '<span class="state tone-err"><span class="state-glyph" aria-hidden="true">✕</span>Needs attention</span>'
    : "";
  return `<li><a class="app-row" href="${escape(app.url)}"><span class="app-name">${escape(app.name)}</span><span class="app-status"><span class="state${tone}"><span class="state-glyph" aria-hidden="true">${glyph}</span>${label}</span>${errorNote}</span>${ROW_ARROW_SVG}</a></li>`;
}

function renderAppList(apps: GateAppView[]): string {
  if (!apps.length) {
    return '<p class="empty">Run <code>fleet init</code> in a project directory to create your first app.</p>';
  }
  return `<ul class="app-list">${apps.map(renderAppRow).join("")}</ul>`;
}

export const loginPage = (app: string, error = "", options: PageOptions = {}): string => {
  const target = app || "fleet";
  return page(
    "Fleet Gate",
    `<h1><code class="app-code">${escape(target)}</code> needs you to log in first.</h1><p>Run <code>fleet gate</code> on the machine that runs Fleet to get your device code.</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}<form class="login-form" method="post" action="/__fleet/login?app=${encodeURIComponent(app)}"><input id="code" class="code-input" name="code" aria-label="Device code" placeholder="A1B2 C3D4 E5F6" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" autofocus required maxlength="32"><div class="actions"><button class="button" type="submit">Connect device</button></div></form>`,
    options,
  );
};

export const homePage = (apps: GateAppView[], options: PageOptions = {}): string =>
  page("Your apps", `<h1>Welcome back.</h1>${renderAppList(apps)}`, {
    brandHref: "/",
    showLogout: true,
    ...options,
  });

const PHONE_WIZARD_SCRIPT = `(()=>{const steps=[...document.querySelectorAll('[data-pane]')];const bars=[...document.querySelectorAll('.wiz-bar')];if(!steps.length)return;const key='fleet-phone-step';const show=n=>{const cur=Math.max(1,Math.min(steps.length,n));steps.forEach((el,i)=>{el.hidden=i+1!==cur;});bars.forEach((b,i)=>{b.dataset.state=i+1===cur?'active':i+1<cur?'done':'todo';b.setAttribute('aria-current',i+1===cur?'step':'false');});try{sessionStorage.setItem(key,String(cur));}catch{}};document.addEventListener('click',e=>{const t=e.target instanceof Element?e.target.closest('[data-go]'):null;if(t)show(Number(t.getAttribute('data-go')));});let saved=1;try{const hash=Number(location.hash.replace('#step-',''));saved=hash>=1&&hash<=steps.length?hash:Number(sessionStorage.getItem(key))||1;}catch{}show(saved);})();`;

export const phoneSetupPage = (params: {
  profileUrl: string;
  openUrl: string;
  fontUrl?: string;
}): string =>
  page(
    "Connect your phone",
    `<div class="wiz-bars" role="navigation" aria-label="Setup steps"><button class="wiz-bar" type="button" data-go="1" data-state="active" aria-label="Step 1"></button><button class="wiz-bar" type="button" data-go="2" data-state="todo" aria-label="Step 2"></button><button class="wiz-bar" type="button" data-go="3" data-state="todo" aria-label="Step 3"></button></div><section class="wiz-step" data-pane="1"><h1>You'll need to install Fleet's certificate profile on your iPhone first.</h1><p>Tailscale must always be connected to access your Fleet apps.</p><p>After downloading the certificate profile, go to Settings, General, VPN &amp; Device Management and install "Fleet private apps".</p><div class="actions"><a class="button" href="${escape(params.profileUrl)}">Download profile</a><button class="text-btn" type="button" data-go="2">Next &rarr;</button></div></section><section class="wiz-step" data-pane="2"><h1>Now, trust the certificate.</h1><p>Go to Settings, General, About, Certificate Trust Settings and turn on "Fleet private apps".</p><div class="actions"><button class="button" type="button" data-go="3">Next &rarr;</button><button class="text-btn" type="button" data-go="1">&larr; Back</button></div></section><section class="wiz-step" data-pane="3"><h1>All set.</h1><p>Continue to Fleet to end the pairing process.</p><div class="actions"><a class="button" href="${escape(params.openUrl)}">Continue to Fleet</a><button class="text-btn" type="button" data-go="2">&larr; Back</button></div></section>`,
    {
      fontUrl: params.fontUrl,
      script: PHONE_WIZARD_SCRIPT,
    },
  );

export const phoneConnectedPage = (params: {
  apps: GateAppView[];
  routeClosed: boolean;
  fontUrl?: string;
}): string =>
  page(
    "Phone connected",
    `<h1>Phone connected.</h1><p>${params.routeClosed ? "Your phone trusts Fleet HTTPS and is signed in. The temporary setup link has been turned off automatically." : "Your phone trusts Fleet HTTPS and is signed in. Run <code>fleet phone off</code> on your computer to close the temporary setup link."}</p>${renderAppList(params.apps)}<div class="actions" style="margin-top:24px"><a class="button" href="/">Continue to Fleet</a></div>`,
    {
      brandHref: "/",
      fontUrl: params.fontUrl,
    },
  );

export const wakePage = (name: string, options: PageOptions = {}): string =>
  page(
    name,
    `<h1><span class="dot" aria-hidden="true"></span>Waking ${escape(name)}..</h1><p>This page will automatically open it when it's ready.</p><p class="status-line" id="status" role="status"></p>`,
    {
      centered: true,
      script: `let tries=0;const timer=setInterval(async()=>{try{const r=await fetch('/__fleet/ready',{cache:'no-store'});const s=await r.json();if(s.ready){clearInterval(timer);location.reload()}else if(s.error||++tries>60){clearInterval(timer);document.getElementById('status').textContent=s.error||'The app did not start. Run fleet logs on its computer.'}}catch{if(++tries>60){clearInterval(timer);document.getElementById('status').textContent='The Fleet computer is not reachable.'}}},500);`,
      ...options,
    },
  );

export const offlinePage = (name: string, gateUrl = "", options: PageOptions = {}): string =>
  page(
    name,
    `<h1>This computer <span>is offline.</span></h1><p>Turn on the computer with ${escape(name)} and connect it to Tailscale. Your app and data stay there.</p><div class="actions" style="margin-top:24px"><a class="button" href="/">Try again</a>${gateUrl ? `<a class="text-link" href="${escape(gateUrl)}">All apps</a>` : ""}</div>`,
    {
      brandHref: gateUrl || undefined,
      ...options,
    },
  );

export const unavailablePage = (gateUrl = "", options: PageOptions = {}): string =>
  page(
    "App unavailable",
    `<h1>This app <span>is unavailable.</span></h1><p>Check that its computer is on and connected to Tailscale. Your agent can read Fleet logs to find the problem.</p><div class="actions" style="margin-top:24px"><a class="button" href="/">Try again</a>${gateUrl ? `<a class="text-link" href="${escape(gateUrl)}">All apps</a>` : ""}</div>`,
    {
      brandHref: gateUrl || undefined,
      ...options,
    },
  );
