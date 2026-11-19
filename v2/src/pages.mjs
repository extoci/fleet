export const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const style = `:root{color-scheme:light dark;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101214;color:#f1f1ef}*{box-sizing:border-box}body{margin:0}main{max-width:680px;margin:10vh auto;padding:32px}nav{font-size:14px;color:#a7aaa9;margin-bottom:56px;letter-spacing:.08em}h1{font-size:clamp(32px,6vw,46px);font-weight:550;line-height:1.15;letter-spacing:-.04em;margin:0 0 20px}p{color:#b9bcbc;max-width:58ch}a{color:inherit;text-underline-offset:4px}button,.button{display:inline-block;background:#d4f38a;color:#122009;border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:550;cursor:pointer;text-decoration:none}input,textarea{background:#1b1e21;border:1px solid #3a4043;border-radius:9px;padding:12px;color:inherit;font:inherit;width:100%;margin:8px 0 16px}input:focus,textarea:focus{outline:2px solid #d4f38a}label{display:block}small{color:#a7aaa9}section{border:1px solid #303538;border-radius:14px;padding:20px;margin:16px 0}section a{font-size:20px;text-decoration:none}code{overflow-wrap:anywhere}pre{white-space:pre-wrap}.error{color:#ffb4ab}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d4f38a;margin-right:8px;animation:pulse 1s infinite}@keyframes pulse{50%{opacity:.25}}@media(prefers-reduced-motion:reduce){.dot{animation:none}}`;
export function page(title, body, script = "") {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escape(title)} · Fleet</title><style>${style}</style><main><nav>FLEET</nav>${body}</main>${script ? `<script>${script}</script>` : ""}</html>`;
}
export const loginPage = (app, error = "") =>
  page(
    "Fleet Gate",
    `<h1>Your apps.<br>Your devices.</h1><p>Connect this browser to Fleet. Run <code>fleet gate</code> on your computer to get a device code.</p>${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}<form method="post" action="/__fleet/login?app=${encodeURIComponent(app)}"><label for="code">Device code</label><input id="code" name="code" autocomplete="one-time-code" autofocus required maxlength="32"><button>Connect device</button></form><p><small>This browser stays connected for 30 days.</small></p>`,
  );
export const wakePage = (name) =>
  page(
    name,
    `<h1><span class="dot"></span>Opening ${escape(name)}.</h1><p>Your app is starting. This page will open it when it is ready.</p><p id="status" role="status"></p>`,
    `let tries=0;const timer=setInterval(async()=>{try{const r=await fetch('/__fleet/ready',{cache:'no-store'});const s=await r.json();if(s.ready){clearInterval(timer);location.reload()}else if(s.error||++tries>60){clearInterval(timer);document.getElementById('status').textContent=s.error||'The app did not start. Run fleet logs on its computer.'}}catch{if(++tries>60){clearInterval(timer);document.getElementById('status').textContent='The Fleet computer is not reachable.'}}},500);`,
  );
