import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { Gate, sameSecret } from "./gate.mjs";
import { authority, leaf, mobileProfile } from "./certificates.mjs";
import { hostname, read, acquire, write, secret } from "./state.mjs";
import { startDNS } from "./dns.mjs";
import { Runtime } from "./runtime.mjs";
import { Peers, peerRequest } from "./peers.mjs";
import { page, escape, loginPage, wakePage } from "./pages.mjs";

export async function body(request, limit = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request exceeds 1 MB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function send(
  response,
  status,
  data,
  type = "text/html; charset=utf-8",
  headers = {},
) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  response.end(data);
}
const json = (res, status, data) =>
  send(res, status, JSON.stringify(data), "application/json");
const redirect = (res, target, cookie) =>
  send(res, 303, "", "text/plain", {
    Location: target,
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  });
const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
const closeServer = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });

export async function start(home, options = {}) {
  const unlock = acquire(home);
  const config = read(path.join(home, "config.json"), null);
  if (!config) {
    unlock();
    throw new Error("Run fleet setup first.");
  }
  const runtime = new Runtime(home, options);
  const gate = new Gate(home);
  const peers = new Peers(home, runtime, {
    allowLoopback: !!options.allowLoopbackPeers,
  });
  const appFor = (name) => runtime.find(name) || peers.find(name);
  const appList = () => [...runtime.list(), ...peers.list()];
  let announceTimer;
  let announcing = false;
  const contexts = new Map();
  const servers = [];
  const dnsServers = [];
  const eventClients = new Set();
  let closed = false;
  let setupToken = secret();
  let setupExpires = Date.now() + 900_000;
  let httpsPort = config.httpsPort ?? 443;
  const originFor = (name) =>
    `https://${name}.fleet${httpsPort === 443 ? "" : `:${httpsPort}`}`;
  function context(name) {
    const existing = contexts.get(name);
    if (existing && existing.expires > Date.now()) return existing.context;
    const value = tls.createSecureContext(leaf(home, name));
    contexts.set(name, { context: value, expires: Date.now() + 12 * 3600_000 });
    return value;
  }
  function known(name) {
    return (
      name === "gate.fleet" ||
      Boolean(appFor(name.replace(/\.fleet$/, "")) && name.endsWith(".fleet"))
    );
  }
  async function handle(request, response) {
    try {
      const host = hostname(request.headers.host);
      if (!known(host) || host !== request.socket.servername?.toLowerCase())
        return send(response, 421, "Unknown Fleet app.", "text/plain");
      const url = new URL(request.url, `https://${request.headers.host}`);
      const isGate = host === "gate.fleet";
      if (
        isGate &&
        url.pathname === "/__fleet/peers/register" &&
        request.method === "POST"
      ) {
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const message = JSON.parse(await body(request));
        return json(response, 200, await peers.announce(token, message.args));
      }
      const app = isGate ? null : appFor(host.slice(0, -6));
      const destination = url.searchParams.get("app") || "";
      const validDestination =
        destination === "" || Boolean(appFor(destination));
      if (!validDestination)
        return send(response, 404, "Unknown app.", "text/plain");
      if (
        request.method === "POST" &&
        request.headers.origin !== `https://${request.headers.host}`
      )
        return json(response, 403, {
          error: "The request origin does not match this app.",
        });
      if (isGate && url.pathname === "/__fleet/login") {
        if (request.method === "POST") {
          const form = new URLSearchParams(await body(request, 4096));
          if (!gate.redeem(form.get("code"), request.socket.remoteAddress))
            return send(
              response,
              403,
              loginPage(
                destination,
                "That code is invalid, expired, or has been used. Run fleet gate for a new code.",
              ),
            );
          const session = gate.session(host);
          return redirect(
            response,
            `/__fleet/login?app=${encodeURIComponent(destination)}`,
            session.cookie,
          );
        }
        if (request.method !== "GET")
          return json(response, 405, { error: "Method not allowed." });
        if (gate.authorized(request, host)) {
          if (!destination) return redirect(response, "/");
          return redirect(
            response,
            `${originFor(destination)}/__fleet/claim?ticket=${encodeURIComponent(gate.ticket(`${destination}.fleet`))}`,
          );
        }
        return send(response, 200, loginPage(destination));
      }
      if (url.pathname === "/__fleet/claim" && request.method === "GET") {
        if (!gate.claim(url.searchParams.get("ticket"), host))
          return redirect(
            response,
            `${originFor("gate")}/__fleet/login?app=${encodeURIComponent(app?.name || destination)}`,
          );
        return redirect(
          response,
          isGate
            ? `/__fleet/login?app=${encodeURIComponent(destination)}`
            : "/",
          gate.session(host).cookie,
        );
      }
      if (!gate.authorized(request, host)) {
        if (url.pathname.startsWith("/__fleet/api/"))
          return json(response, 401, { error: "Sign in through Fleet Gate." });
        return redirect(
          response,
          `${originFor("gate")}/__fleet/login?app=${encodeURIComponent(app?.name || "")}`,
        );
      }
      if (app?.peer && !app.online)
        return send(
          response,
          503,
          page(
            app.name,
            `<h1>This computer is offline.</h1><p>Turn on the computer with ${escape(app.name)} and connect it to Tailscale. Your app and data stay there.</p><a class="button" href="/">Try again</a>`,
          ),
        );
      if (url.pathname === "/__fleet/logout" && request.method === "POST")
        return redirect(
          response,
          `${originFor("gate")}/__fleet/login`,
          "__Host-fleet=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        );
      if (isGate) {
        if (request.method !== "GET")
          return json(response, 405, { error: "Method not allowed." });
        const apps = appList();
        return send(
          response,
          200,
          page(
            "Your apps",
            `<h1>Your apps.</h1><p>Private. On your computers.</p>${apps.length ? apps.map((a) => `<section><a href="${originFor(a.name)}">${escape(a.name)}</a><p><small>${a.running ? "Running" : "Ready on demand"}${a.error ? " · Latest edit needs attention" : ""}</small></p></section>`).join("") : "<p>Run <code>fleet init</code> in a project directory to create your first app.</p>"}`,
          ),
        );
      }
      if (url.pathname === "/__fleet/ready") {
        if (!app.peer && !app.revision && !app.building)
          runtime.build(app).catch(() => {});
        return json(response, 200, {
          ready: Boolean(app.revision),
          error: app.revision ? null : app.buildError,
        });
      }
      if (url.pathname === "/__fleet/events" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ revision: app.revision })}\n\n`,
        );
        let revision = app.revision;
        const interval = setInterval(() => {
          if (!gate.authorized(request, host)) return response.end();
          if (app.peer) app.revision = peers.find(app.name)?.revision;
          if (revision !== app.revision) {
            revision = app.revision;
            response.write(`data: ${JSON.stringify({ revision })}\n\n`);
          } else response.write(": keepalive\n\n");
        }, 1500);
        eventClients.add(response);
        response.once("close", () => {
          clearInterval(interval);
          eventClients.delete(response);
        });
        return;
      }
      const operation =
        /^\/__fleet\/api\/(queries|mutations)\/([a-zA-Z][\w-]{0,63})$/.exec(
          url.pathname,
        );
      if (operation) {
        if (request.method !== "POST")
          return json(response, 405, { error: "Use POST for app operations." });
        if (!request.headers["content-type"]?.startsWith("application/json"))
          return json(response, 415, { error: "Send application/json." });
        const input = JSON.parse(await body(request));
        const value = app.peer
          ? (
              await peers.call(app, "call", {
                kind: operation[1],
                name: operation[2],
                input,
              })
            ).value
          : await runtime.call(app, operation[1], operation[2], input);
        return json(response, 200, { value });
      }
      if (url.pathname.startsWith("/__fleet/"))
        return json(response, 404, { error: "Unknown Fleet route." });
      if (request.method !== "GET" && request.method !== "HEAD")
        return json(response, 405, { error: "Use app operations for writes." });
      if (!app.revision) {
        if (!app.peer && !app.building) runtime.build(app).catch(() => {});
        return send(response, 200, wakePage(app.name));
      }
      if (["/app.js", "/app.css"].includes(url.pathname)) {
        if (app.peer) {
          const asset = await peers.call(app, "asset", {
            file: url.pathname.slice(1),
          });
          return send(
            response,
            asset.status,
            Buffer.from(asset.data, "base64"),
            asset.type,
          );
        }
        const file = path.join(app.buildDir, url.pathname.slice(1));
        if (!fs.existsSync(file)) return send(response, 404, "", "text/plain");
        return send(
          response,
          200,
          request.method === "HEAD" ? "" : fs.readFileSync(file),
          url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
        );
      }
      return send(
        response,
        200,
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(app.name)}</title>${app.peer || fs.existsSync(path.join(app.buildDir, "app.css")) ? '<link rel="stylesheet" href="/app.css">' : ""}<div id="app"></div><script type="module" src="/app.js"></script><script>const revision=${JSON.stringify(app.revision)};const events=new EventSource('/__fleet/events');events.onmessage=e=>{if(JSON.parse(e.data).revision!==revision)location.reload()};</script></html>`,
      );
    } catch (error) {
      runtime.log("daemon", error.message);
      if (response.headersSent) response.end();
      else if (
        request.method === "GET" &&
        request.headers.accept?.includes("text/html")
      )
        send(
          response,
          503,
          page(
            "App unavailable",
            '<h1>This app is unavailable.</h1><p>Check that its computer is on and connected to Tailscale. Your agent can read Fleet logs to find the problem.</p><a class="button" href="/">Try again</a>',
          ),
        );
      else json(response, 500, { error: error.message });
    }
  }
  async function admin(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/health")
        return json(response, 200, { version: 2 });
      if (
        url.pathname === `/setup/${setupToken}` &&
        Date.now() < setupExpires &&
        request.method === "GET"
      ) {
        const ticket = gate.ticket("gate.fleet", 600_000);
        return send(
          response,
          200,
          page(
            "Connect your phone",
            `<h1>Fleet on your phone.</h1><p>Keep Tailscale connected.</p><section><h2>1. Install your Fleet profile</h2><p>Download the profile, then open Settings and tap Profile Downloaded, Install.</p><a class="button" href="/setup/${setupToken}/fleet.mobileconfig">Download profile</a></section><section><h2>2. Enable trust</h2><p>In Settings, open General, About, Certificate Trust Settings. Enable Fleet private apps.</p><small>Your computer can then issue trusted website certificates. This profile adds its public certificate. It does not enroll the phone in device management.</small></section><section><h2>3. Open your apps</h2><p>Return here after enabling trust. This button connects your browser through Fleet Gate.</p><a class="button" href="${originFor("gate")}/__fleet/claim?ticket=${ticket}">Open Fleet</a></section>`,
          ),
        );
      }
      if (
        url.pathname === `/setup/${setupToken}/fleet.mobileconfig` &&
        Date.now() < setupExpires &&
        request.method === "GET"
      )
        return send(
          response,
          200,
          mobileProfile(home),
          "application/x-apple-aspen-config",
          {
            "Content-Disposition": 'attachment; filename="fleet.mobileconfig"',
          },
        );
      if (
        !sameSecret(
          request.headers.authorization,
          `Bearer ${config.adminToken}`,
        )
      )
        return json(response, 403, {
          error: "Local Fleet authorization required.",
        });
      if (request.method !== "POST" || url.pathname !== "/rpc")
        return json(response, 404, { error: "Not found." });
      const { method, args = {} } = JSON.parse(await body(request));
      if (method === "list") return json(response, 200, appList());
      if (method === "invite")
        return json(
          response,
          200,
          peers.invite({ ...config, httpsPort }, authority(home).pem),
        );
      if (method === "pair") return json(response, 200, { code: gate.pair() });
      if (method === "browser") {
        if (args.app && !appFor(args.app))
          return json(response, 404, { error: "Unknown app." });
        return json(response, 200, {
          url: `${originFor("gate")}/__fleet/claim?ticket=${gate.ticket("gate.fleet")}&app=${encodeURIComponent(args.app || "")}`,
        });
      }
      if (method === "reset") {
        gate.reset();
        for (const client of eventClients) client.end();
        return json(response, 200, { reset: true });
      }
      if (method === "setup") {
        setupToken = secret();
        setupExpires = Date.now() + 900_000;
        return json(response, 200, {
          path: `/setup/${setupToken}`,
          expires: setupExpires,
        });
      }
      if (method === "call") {
        const app = appFor(args.app);
        if (!app) return json(response, 404, { error: "Unknown app." });
        return json(
          response,
          200,
          app.peer
            ? await peers.call(app, "call", args)
            : {
                value: await runtime.call(
                  app,
                  args.kind,
                  args.name,
                  args.input,
                ),
              },
        );
      }
      return json(response, 400, { error: "Unknown agent command." });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: error.message });
    }
  }
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    for (const client of eventClients) client.end();
    clearInterval(announceTimer);
    await runtime.close();
    await Promise.all([
      ...servers.map(closeServer),
      ...dnsServers.map((s) => s.close()),
    ]);
    fs.rmSync(path.join(home, "running.json"), { force: true });
    unlock();
  };
  try {
    authority(home);
    const hosts = options.hosts || [
      ...new Set(["127.0.0.1", ...(config.addresses || [])]),
    ];
    for (const host of config.mode === "node" ? [] : hosts) {
      const server = https.createServer(
        {
          ...leaf(home, "gate.fleet"),
          minVersion: "TLSv1.2",
          SNICallback: (name, callback) => {
            const normalized = name.toLowerCase();
            if (!known(normalized))
              return callback(new Error("Unknown Fleet app."));
            try {
              callback(null, context(normalized));
            } catch (error) {
              callback(error);
            }
          },
        },
        handle,
      );
      server.requestTimeout = 20_000;
      server.headersTimeout = 10_000;
      servers.push(server);
      const bound = await listen(server, options.httpsPort ?? httpsPort, host);
      if (!httpsPort || options.httpsPort === 0) httpsPort = bound;
      if (!options.noDns)
        dnsServers.push(
          await startDNS({
            host,
            port: options.dnsPort ?? config.dnsPort ?? 53,
            addresses: config.addresses,
            names: () =>
              new Set([
                "gate.fleet",
                ...appList().map((a) => `${a.name}.fleet`),
              ]),
          }),
        );
    }
    const local = http.createServer(admin);
    servers.push(local);
    local.requestTimeout = 15_000;
    const adminPort = await listen(
      local,
      options.adminPort ?? config.adminPort ?? 42173,
      "127.0.0.1",
    );
    const running = {
      pid: process.pid,
      httpsPort,
      adminPort,
      setupPath: `/setup/${setupToken}`,
      started: new Date().toISOString(),
    };
    write(path.join(home, "running.json"), running);
    if (config.mode === "node") {
      const node = https.createServer(
        { ...leaf(home, "gate.fleet"), minVersion: "TLSv1.2" },
        async (request, response) => {
          try {
            if (
              request.method !== "POST" ||
              request.url !== "/node" ||
              !sameSecret(
                request.headers.authorization,
                `Bearer ${config.nodeToken}`,
              )
            )
              return json(response, 403, {
                error: "Fleet computer authorization required.",
              });
            const { method, args = {} } = JSON.parse(await body(request));
            if (method === "probe")
              return json(response, 200, { id: config.nodeId });
            const app = runtime.find(args.app);
            if (!app)
              return json(response, 404, {
                error: "Unknown app on this computer.",
              });
            if (method === "call")
              return json(response, 200, {
                value: await runtime.call(
                  app,
                  args.kind,
                  args.name,
                  args.input,
                ),
              });
            if (
              method === "asset" &&
              ["app.js", "app.css"].includes(args.file)
            ) {
              const file = app.buildDir && path.join(app.buildDir, args.file);
              return json(response, 200, {
                status: file && fs.existsSync(file) ? 200 : 404,
                type: args.file.endsWith(".css")
                  ? "text/css"
                  : "text/javascript",
                data:
                  file && fs.existsSync(file)
                    ? fs.readFileSync(file).toString("base64")
                    : "",
              });
            }
            return json(response, 400, {
              error: "Unknown computer operation.",
            });
          } catch (error) {
            json(response, 500, { error: error.message });
          }
        },
      );
      servers.push(node);
      const nodePort = await listen(
        node,
        options.nodePort ?? config.nodePort ?? 42174,
        config.addresses.find((a) => a.includes(".")),
      );
      const announce = async () => {
        if (announcing || closed) return;
        announcing = true;
        try {
          await peerRequest(
            {
              ...config.gateway,
              token: config.gateway.joinToken || config.nodeToken,
              route: "/__fleet/peers/register",
            },
            "register",
            {
              id: config.nodeId,
              address: config.addresses.find((a) => a.includes(".")),
              port: nodePort,
              ca: authority(home).pem,
              token: config.nodeToken,
              apps: runtime.list(),
            },
          );
          if (config.gateway.joinToken) {
            delete config.gateway.joinToken;
            write(path.join(home, "config.json"), config);
          }
        } catch (error) {
          runtime.log("daemon", `Computer registration: ${error.message}`);
        } finally {
          announcing = false;
        }
      };
      announceTimer = setInterval(announce, 3000);
      announceTimer.unref();
      await runtime.tick();
      await announce();
    } else await runtime.tick();
    return { ...running, runtime, gate, close: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
