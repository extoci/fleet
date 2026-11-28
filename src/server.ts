import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tls, { type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import type { OperationKind } from "./app-definition.ts";
import { authority, leaf, mobileProfile } from "./certificates.ts";
import { type DnsServer, startDNS } from "./dns.ts";
import {
  type EventMeta,
  MAX_EVENT_DEPTH,
  matchesEventPattern,
  validateEventTopic,
} from "./events.ts";
import { Gate, sameSecret } from "./gate.ts";
import {
  escape,
  FONT_ROUTE,
  type GateAppView,
  homePage,
  loginPage,
  offlinePage,
  phoneConnectedPage,
  phoneSetupPage,
  servicePage,
  unavailablePage,
  wakePage,
} from "./pages.ts";
import { type PeerAppView, Peers, peerRequest } from "./peers.ts";
import { turnOffPhoneRoute } from "./platform.ts";
import { type AppSummary, type LocalAppState, Runtime } from "./runtime.ts";
import { acquire, type FleetConfig, hostname, read, readAliases, secret, write } from "./state.ts";

class BodyLimitError extends Error {}

let cachedHeadingFont: Buffer | null | undefined;
function headingFont(): Buffer | null {
  if (cachedHeadingFont !== undefined) return cachedHeadingFont;
  try {
    cachedHeadingFont = fs.readFileSync(
      fileURLToPath(new URL("./assets/GeistPixel-Square.woff2", import.meta.url)),
    );
  } catch {
    cachedHeadingFont = null;
  }
  return cachedHeadingFont;
}

export async function body(request: IncomingMessage, limit = 1_048_576): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > limit) {
      request.resume();
      throw new BodyLimitError(`Request exceeds ${limit} bytes.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(
  response: ServerResponse,
  status: number,
  data: string | Buffer | Readable | undefined,
  type = "text/html; charset=utf-8",
  headers: Record<string, string | number> = {},
): Promise<void> | void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  if (data instanceof Readable) return pipeline(data, response);
  response.end(data);
}

const publicTypes: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".css": "text/css",
  ".js": "text/javascript",
  ".html": "text/html; charset=utf-8",
};

function safePublicPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    // eslint-disable-next-line no-control-regex
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    !value
      .slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === "..") &&
    !/^\/(?:__fleet(?:\/|$)|app\.(?:js|css)$)/.test(value)
  );
}

function requestPublicPath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const file = decodeURIComponent(url.split("?", 1)[0]);
    if (safePublicPath(file)) return file;
  } catch {
    // An invalid escape cannot refer to an asset.
  }
  return undefined;
}

interface PublicAsset {
  file?: string;
  stream?: Readable;
  status: number;
  type: string;
  etag: string;
  size: number | string;
}

function publicAsset(
  app: LocalAppState,
  name: string,
  ifNoneMatch: string | undefined,
): PublicAsset | undefined {
  if (!app.hasPublic || !app.buildDir || !safePublicPath(name)) return undefined;
  const file = path.join(app.buildDir, "public", name.slice(1));
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file, { throwIfNoEntry: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
  if (!stat?.isFile()) return undefined;
  const etag = `"${app.revision}"`;
  const matched =
    typeof ifNoneMatch === "string" &&
    ifNoneMatch.split(",").some((tag) => ["*", etag, `W/${etag}`].includes(tag.trim()));
  return {
    file,
    status: matched ? 304 : 200,
    type: publicTypes[path.extname(file).toLowerCase()] || "application/octet-stream",
    etag,
    size: stat.size,
  };
}

function sendPublic(
  response: ServerResponse,
  asset: PublicAsset,
  { head = false, peer = false } = {},
) {
  const { status, type, etag, size } = asset;
  const data =
    status === 304 || head
      ? undefined
      : asset.stream || (asset.file ? fs.createReadStream(asset.file) : undefined);
  return send(response, status, data, type, {
    "Cache-Control": "private, no-cache",
    ETag: etag,
    ...(status === 200 && (!peer || !head) ? { "Content-Length": size } : {}),
    ...(peer ? { "X-Fleet-Public-Asset": "1", "X-Fleet-Asset-Size": size } : {}),
  });
}

// Files in a build dir are immutable, so buffer each variant once per build
// instead of reading it off disk on every request.
function appAsset(app: LocalAppState, file: string): Buffer | undefined {
  if (!app.assets || app.assets.dir !== app.buildDir) {
    app.assets = { dir: app.buildDir, files: new Map() };
  }
  let data = app.assets.files.get(file);
  if (!data) {
    if (!fs.existsSync(file)) return undefined;
    data = fs.readFileSync(file);
    if (app.assets.files.size > 64) app.assets.files.clear();
    app.assets.files.set(file, data);
  }
  return data;
}

function appHead(app: LocalAppState | PeerAppView): string {
  const { title = app.name, themeColor, icon, manifest } = app.head || {};
  return (
    `<title>${escape(title)}</title>` +
    (themeColor ? `<meta name="theme-color" content="${escape(themeColor)}">` : "") +
    (icon
      ? `<link rel="icon" href="${escape(icon)}"><link rel="apple-touch-icon" href="${escape(icon)}">`
      : "") +
    (manifest ? `<link rel="manifest" href="${escape(manifest)}">` : "")
  );
}

const clientErrorRoute = "/__fleet/client-error";
const clientErrorReporter = `<script>(() => {
  let remaining = 5;
  function report(message) {
    if (!remaining || typeof message !== 'string' || !message) return;
    remaining--;
    fetch('${clientErrorRoute}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message.slice(0, 512) }),
      keepalive: true,
    }).catch(() => {});
  }
  window.addEventListener('error', event => report(event.message));
  window.addEventListener('unhandledrejection', ({ reason }) => {
    report(reason instanceof Error ? reason.message :
      typeof reason === 'string' ? reason : 'Unhandled promise rejection');
  });
})();</script>`;

function clientErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return (
      value
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")
        .trim()
        .slice(0, 1024)
    );
  }
  return undefined;
}

export function encodings(header = ""): Set<string> {
  const accepted = new Set<string>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.find((p) => p.trim().startsWith("q="));
    if (name && !(q && Number(q.trim().slice(2)) === 0)) accepted.add(name);
  }
  return accepted;
}

const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, JSON.stringify(data), "application/json");

const redirect = (res: ServerResponse, target: string, cookie?: string) =>
  send(res, 303, "", "text/plain", {
    Location: target,
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  });

interface ClosableServer {
  close: () => Promise<void>;
}

function listenNet(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Server did not bind to a TCP port."));
      } else {
        resolve(address.port);
      }
    });
  });
}

// Bun's node:https fast path does not invoke SNICallback, whereas node:tls
// invokes SNICallback per connection. Feeding secure sockets into an http.Server
// gives identical per-app certificate selection across Bun and Node.
function createTlsHttpServer(
  tlsOptions: tls.TlsOptions,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  timeouts: { requestTimeout?: number; headersTimeout?: number } = {},
) {
  const sockets = new Set<net.Socket>();
  const httpServer = http.createServer(handler);
  if (timeouts.requestTimeout !== undefined) httpServer.requestTimeout = timeouts.requestTimeout;
  if (timeouts.headersTimeout !== undefined) httpServer.headersTimeout = timeouts.headersTimeout;
  const tlsServer = tls.createServer(tlsOptions, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {
      // Ignore client TLS disconnects.
    });
    httpServer.emit("connection", socket);
  });
  tlsServer.on("tlsClientError", (_err, socket) => {
    socket.destroy();
  });
  return {
    server: tlsServer,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        tlsServer.close(() => resolve());
      }),
  };
}

function wrapHttpServer(server: http.Server): ClosableServer {
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface StartOptions {
  hosts?: string[];
  httpsPort?: number;
  dnsPort?: number;
  adminPort?: number;
  nodePort?: number;
  noDns?: boolean;
  idleMs?: number;
  pollMs?: number;
  allowLoopbackPeers?: boolean;
  disablePhoneRoute?: () => Promise<unknown>;
}

function isPeerApp(app: LocalAppState | PeerAppView): app is PeerAppView {
  return Boolean(app.peer);
}

export async function start(home: string, options: StartOptions = {}) {
  const unlock = acquire(home);
  const config = read<FleetConfig | null>(path.join(home, "config.json"), null);
  if (!config) {
    unlock();
    throw new Error("Run fleet setup first.");
  }
  const runtime = new Runtime(home, options);
  const gate = new Gate(home);
  const peers = new Peers(home, runtime, {
    allowLoopback: Boolean(options.allowLoopbackPeers),
  });
  const appFor = (name: string): LocalAppState | PeerAppView | undefined =>
    runtime.find(name) || peers.find(name);
  const appList = () => [...runtime.list(), ...peers.list()];
  const inspectApp = (app: AppSummary | PeerAppView) => {
    const jobs = read<Record<string, unknown>>(path.join(home, "jobs.json"), {});
    return {
      ...app,
      jobsState: Object.fromEntries(
        Object.entries(jobs).filter(([key]) => key.startsWith(`${app.id}/`)),
      ),
      url: `${originFor(app.name)}`,
    };
  };
  const aliases = () => readAliases(home, { shared: true });
  const aliasFor = (name: string) => aliases().find((alias) => alias.name === name);
  const routeExists = (name: string) => Boolean(aliasFor(name) || appFor(name));

  function forwardEventToPeers(
    event: EventMeta,
    payload: unknown,
    excludePeerId?: string,
  ): Array<{ app: string; handler: string }> {
    const matchedTargets: Array<{ app: string; handler: string }> = [];
    const peerIds = new Set<string>();
    for (const peerApp of peers.list()) {
      if (!peerApp.online || peerApp.peer === excludePeerId) continue;
      for (const handler of peerApp.operations.events || []) {
        if (matchesEventPattern(handler, event.topic)) {
          matchedTargets.push({ app: peerApp.name, handler });
          peerIds.add(peerApp.peer);
        }
      }
    }
    for (const peerId of peerIds) {
      const peer = peers.all().find((p) => p.id === peerId);
      if (!peer) continue;
      void peerRequest(peer, "event", { event, payload }).catch((error: unknown) => {
        runtime.log(
          "daemon",
          `Peer event ${event.topic} to ${peer.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return matchedTargets;
  }

  function forwardEventToGateway(event: EventMeta, payload: unknown): void {
    if (config?.mode !== "node" || !config.gateway || !config.nodeId || !config.nodeToken) return;
    void peerRequest(
      {
        ...config.gateway,
        token: config.nodeToken,
        route: "/__fleet/peers/event",
      },
      "event",
      { peerId: config.nodeId, event, payload },
    ).catch((error: unknown) => {
      runtime.log(
        "daemon",
        `Gateway event ${event.topic} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  runtime.onPublish(({ event, payload }) => {
    if (config.mode === "node") forwardEventToGateway(event, payload);
    else forwardEventToPeers(event, payload);
  });

  let announceTimer: ReturnType<typeof setInterval> | undefined;
  let announcing = false;
  const contexts = new Map<string, { context: tls.SecureContext; expires: number }>();
  const servers: ClosableServer[] = [];
  const dnsServers: DnsServer[] = [];
  const eventClients = new Set<ServerResponse>();
  const clientErrorWindows = new Map<string, { count: number; until: number }>();
  const phoneTickets = new Set<string>();
  let phoneRouteClosed = true;
  let closed = false;
  let setupToken: string | null = secret();
  let setupExpires = Date.now() + 900_000;
  let httpsPort = config.httpsPort ?? 443;

  const originFor = (name: string) =>
    `https://${name}.fleet${httpsPort === 443 ? "" : `:${httpsPort}`}`;

  function context(name: string): tls.SecureContext {
    const existing = contexts.get(name);
    if (existing && existing.expires > Date.now()) return existing.context;
    const value = tls.createSecureContext(leaf(home, name));
    contexts.set(name, { context: value, expires: Date.now() + 12 * 3600_000 });
    return value;
  }

  function known(name: string): boolean {
    return name.endsWith(".fleet") && (name === "gate.fleet" || routeExists(name.slice(0, -6)));
  }

  function permitClientError(id: string): boolean {
    const now = Date.now();
    for (const [key, window] of clientErrorWindows) {
      if (window.until <= now) clientErrorWindows.delete(key);
    }
    const window = clientErrorWindows.get(id) || {
      count: 0,
      until: now + 60_000,
    };
    if (window.count >= 10) return false;
    window.count++;
    clientErrorWindows.set(id, window);
    return true;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const host = hostname(request.headers.host);
      const rawServername = (request.socket as TLSSocket).servername;
      const servername = typeof rawServername === "string" ? rawServername.toLowerCase() : "";
      if (!host.endsWith(".fleet") || host !== servername) {
        send(response, 421, "Unknown Fleet app.", "text/plain");
        return;
      }
      const isGate = host === "gate.fleet";
      const name = host.slice(0, -6);
      const alias = isGate ? undefined : aliasFor(name);
      const app = isGate || alias ? undefined : appFor(name);
      if (!isGate && !app && !alias) {
        send(response, 421, "Unknown Fleet app.", "text/plain");
        return;
      }
      const url = new URL(request.url || "/", `https://${request.headers.host}`);
      if (
        !alias &&
        url.pathname === FONT_ROUTE &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const font = headingFont();
        if (!font) {
          send(response, 404, "", "text/plain");
          return;
        }
        send(response, 200, request.method === "HEAD" ? undefined : font, "font/woff2", {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Length": font.length,
        });
        return;
      }
      if (isGate && url.pathname === "/__fleet/peers/register" && request.method === "POST") {
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const message = JSON.parse(await body(request)) as { args: Record<string, unknown> };
        json(response, 200, await peers.announce(token, message.args));
        return;
      }
      if (isGate && url.pathname === "/__fleet/peers/event" && request.method === "POST") {
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const message = JSON.parse(await body(request)) as {
          args?: { peerId?: string; event?: EventMeta; payload?: unknown };
        };
        const peerId = message.args?.peerId;
        const sender = peers.verifyPeer(token, peerId);
        if (!sender) {
          json(response, 403, { error: "Fleet computer authorization required." });
          return;
        }
        const incoming = message.args?.event;
        if (
          !incoming ||
          typeof incoming.id !== "string" ||
          typeof incoming.source !== "string" ||
          typeof incoming.at !== "string" ||
          typeof incoming.depth !== "number" ||
          !Number.isInteger(incoming.depth) ||
          incoming.depth < 0 ||
          incoming.depth > MAX_EVENT_DEPTH
        ) {
          json(response, 400, { error: "Invalid peer event." });
          return;
        }
        const topic = validateEventTopic(incoming.topic);
        const result = runtime.emitEvent(
          incoming.source,
          topic,
          message.args?.payload,
          incoming.depth,
          { notifyPeers: false, eventId: incoming.id, at: incoming.at },
        );
        const forwarded = !result.dropped
          ? forwardEventToPeers({ ...incoming, topic }, message.args?.payload, sender.id)
          : [];
        json(response, 200, {
          ...result,
          matched: result.matched + forwarded.length,
          targets: [...result.targets, ...forwarded],
        });
        return;
      }
      const isClientError = Boolean(app && url.pathname === clientErrorRoute);
      const destination = alias ? "" : url.searchParams.get("app") || "";
      const validDestination =
        !destination || (isGate ? routeExists(destination) : appFor(destination));
      if (!validDestination) {
        send(response, 404, "Unknown app.", "text/plain");
        return;
      }
      if (
        request.method === "POST" &&
        request.headers.origin !== `https://${request.headers.host}`
      ) {
        json(response, 403, { error: "The request origin does not match this app." });
        return;
      }
      if (isGate && url.pathname === "/__fleet/login") {
        if (request.method === "POST") {
          const form = new URLSearchParams(await body(request, 4096));
          if (!gate.redeem(form.get("code"), request.socket.remoteAddress)) {
            send(
              response,
              403,
              loginPage(
                destination,
                "That code is invalid, expired, or has been used. Run fleet gate for a new code.",
              ),
            );
            return;
          }
          const session = gate.session(host, request.headers["user-agent"]);
          redirect(
            response,
            `/__fleet/login?app=${encodeURIComponent(destination)}`,
            session.cookie,
          );
          return;
        }
        if (request.method !== "GET") {
          json(response, 405, { error: "Method not allowed." });
          return;
        }
        if (gate.authorized(request, host)) {
          if (!destination) {
            redirect(response, "/");
            return;
          }
          redirect(
            response,
            `${originFor(destination)}/__fleet/claim?ticket=${encodeURIComponent(gate.ticket(`${destination}.fleet`))}`,
          );
          return;
        }
        send(response, 200, loginPage(destination));
        return;
      }
      if (isGate && url.pathname === "/phone" && request.method === "GET") {
        const ticket = url.searchParams.get("ticket");
        if (ticket) {
          if (phoneTickets.has(ticket) && gate.claim(ticket, host)) {
            phoneTickets.clear();
            setupToken = null;
            setupExpires = 0;
            let routeClosed = true;
            try {
              const disable =
                options.disablePhoneRoute || (() => turnOffPhoneRoute(home, { timeout: 5_000 }));
              await disable();
            } catch (error) {
              routeClosed = false;
              runtime.log(
                "daemon",
                `Automatic phone off failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            phoneRouteClosed = routeClosed;
            redirect(response, "/phone", gate.session(host, request.headers["user-agent"]).cookie);
            return;
          }
          if (gate.authorized(request, host)) {
            redirect(response, "/phone");
            return;
          }
          redirect(response, `${originFor("gate")}/__fleet/login`);
          return;
        }
      }
      if (url.pathname === "/__fleet/claim" && request.method === "GET") {
        if (!gate.claim(url.searchParams.get("ticket"), host)) {
          redirect(
            response,
            `${originFor("gate")}/__fleet/login?app=${encodeURIComponent(isGate ? destination : name)}`,
          );
          return;
        }
        redirect(
          response,
          isGate ? `/__fleet/login?app=${encodeURIComponent(destination)}` : "/",
          gate.session(host, request.headers["user-agent"]).cookie,
        );
        return;
      }
      if (!gate.authorized(request, host)) {
        if (!alias && (isClientError || url.pathname.startsWith("/__fleet/api/"))) {
          json(response, 401, { error: "Sign in through Fleet Gate." });
          return;
        }
        redirect(
          response,
          `${originFor("gate")}/__fleet/login?app=${encodeURIComponent(isGate ? "" : name)}`,
        );
        return;
      }
      if (alias) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          send(response, 405, "Use GET or HEAD.", "text/plain", { Allow: "GET, HEAD" });
          return;
        }
        send(response, 302, "", "text/plain", { Location: alias.target });
        return;
      }
      if (app?.peer && !app.online) {
        send(response, 503, offlinePage(app.name, originFor("gate")));
        return;
      }
      if (url.pathname === "/__fleet/logout" && request.method === "POST") {
        gate.revokeRequest(request);
        redirect(
          response,
          `${originFor("gate")}/__fleet/login`,
          "__Host-fleet=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        );
        return;
      }
      if (isGate) {
        if (request.method !== "GET") {
          json(response, 405, { error: "Method not allowed." });
          return;
        }
        const apps: GateAppView[] = appList().map((a) => ({
          name: a.name,
          url: originFor(a.name),
          running: a.running,
          building: "building" in a ? a.building : false,
          error: a.error,
          peer: "peer" in a ? a.peer : undefined,
          online: "online" in a ? a.online : undefined,
        }));
        for (const alias of aliases()) {
          apps.push({ name: alias.name, url: originFor(alias.name), running: false, alias: true });
        }
        if (url.pathname === "/phone") {
          send(response, 200, phoneConnectedPage({ apps, routeClosed: phoneRouteClosed }));
          return;
        }
        send(response, 200, homePage(apps));
        return;
      }
      if (!app) {
        send(response, 404, "Unknown app.", "text/plain");
        return;
      }
      if (isClientError) {
        if (request.method !== "POST") {
          json(response, 405, { error: "Use POST for client errors." });
          return;
        }
        if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
          json(response, 415, { error: "Send application/json." });
          return;
        }
        if (!permitClientError(app.id)) {
          json(response, 429, { error: "Too many client error reports." });
          return;
        }
        let message: string | undefined;
        try {
          const report = JSON.parse(await body(request, 4096)) as { message?: unknown };
          message = clientErrorMessage(report?.message);
        } catch (error) {
          if (error instanceof BodyLimitError) {
            json(response, 413, { error: error.message });
            return;
          }
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (!message) {
          json(response, 400, { error: "Send a client error message." });
          return;
        }
        if (app.peer) await peers.call(app, "client-error", { message });
        else runtime.log(app.id, `Client error: ${message}`);
        send(response, 204, undefined, "text/plain");
        return;
      }
      if (url.pathname === "/__fleet/ready") {
        if (!isPeerApp(app) && !app.revision && !app.building) {
          runtime.build(app).catch(() => {
            // Build error is recorded on app.buildError.
          });
        }
        json(response, 200, {
          ready: Boolean(app.revision),
          error: app.revision ? null : isPeerApp(app) ? app.error : app.buildError,
        });
        return;
      }
      if (url.pathname === "/__fleet/events" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        const current = () => (isPeerApp(app) ? (peers.find(app.name) ?? app) : app);
        const revisionFor = () => current().revision ?? null;
        const dataVersionFor = () => current().dataVersion || 0;
        const emit = (type: "state" | "revision" | "data") => {
          response.write(
            `data: ${JSON.stringify({
              type,
              revision: revisionFor(),
              dataVersion: dataVersionFor(),
            })}\n\n`,
          );
        };
        emit("state");
        let revision = revisionFor();
        let dataVersion = dataVersionFor();
        const update = (type?: "revision" | "data") => {
          const nextRevision = revisionFor();
          const nextDataVersion = dataVersionFor();
          if (nextRevision === revision && nextDataVersion === dataVersion) return false;
          const kind = type || (nextRevision !== revision ? "revision" : "data");
          revision = nextRevision;
          dataVersion = nextDataVersion;
          emit(kind);
          return true;
        };
        const authorizedUpdate = (type: "revision" | "data") => {
          if (gate.authorized(request, host)) update(type);
        };
        // Local builds and commits are pushed immediately. Peer announcements
        // carry peer data versions, while the interval remains a fallback for
        // peer revisions and sign-in expiry.
        const stopRevision = runtime.onRevision((built) => {
          if (built === app) authorizedUpdate("revision");
        });
        const stopLocalData = runtime.onData((changed) => {
          if (changed === app) authorizedUpdate("data");
        });
        const stopPeerData = peers.onData((changed) => {
          if (isPeerApp(app) && changed.id === app.id) authorizedUpdate("data");
        });
        const interval = setInterval(() => {
          if (!gate.authorized(request, host)) {
            response.end();
            return;
          }
          if (!update()) response.write(": keepalive\n\n");
        }, 1500);
        eventClients.add(response);
        response.once("close", () => {
          stopRevision();
          stopLocalData();
          stopPeerData();
          clearInterval(interval);
          eventClients.delete(response);
        });
        return;
      }
      const operation = /^\/__fleet\/api\/(queries|mutations)\/([a-zA-Z][\w-]{0,63})$/.exec(
        url.pathname,
      );
      if (operation) {
        if (request.method !== "POST") {
          json(response, 405, { error: "Use POST for app operations." });
          return;
        }
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          json(response, 415, { error: "Send application/json." });
          return;
        }
        const input: unknown = JSON.parse(await body(request));
        const kind = operation[1] as OperationKind;
        const value = isPeerApp(app)
          ? (
              (await peers.call(app, "call", { kind, name: operation[2], input })) as {
                value: unknown;
              }
            ).value
          : await runtime.call(app, kind, operation[2], input);
        json(response, 200, { value });
        return;
      }
      if (url.pathname.startsWith("/__fleet/")) {
        json(response, 404, { error: "Unknown Fleet route." });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        json(response, 405, { error: "Use app operations for writes." });
        return;
      }
      if (!app.revision) {
        if (!isPeerApp(app) && !app.building) {
          runtime.build(app).catch(() => {
            // Build error is recorded on app.buildError.
          });
        }
        send(response, 200, wakePage(app.name, { brandHref: originFor("gate") }));
        return;
      }
      if (["/app.js", "/app.css"].includes(url.pathname)) {
        if (isPeerApp(app)) {
          const head = request.method === "HEAD";
          const currentTag = `"${app.revision}"`;
          if (request.headers["if-none-match"] === currentTag) {
            send(
              response,
              304,
              undefined,
              url.pathname.endsWith(".css") ? "text/css" : "text/javascript",
              {
                "Cache-Control":
                  url.searchParams.get("v") === app.revision
                    ? "private, max-age=31536000, immutable"
                    : "private, no-cache",
                ETag: currentTag,
                Vary: "Accept-Encoding",
              },
            );
            return;
          }
          const accepted = encodings(request.headers["accept-encoding"]);
          const encoding = accepted.has("br") ? "br" : accepted.has("gzip") ? "gzip" : undefined;
          const asset = (await peers.call(app, "asset", {
            file: url.pathname.slice(1),
            encoding,
            head,
            ifNoneMatch: request.headers["if-none-match"],
          })) as {
            status: number;
            data: string;
            type: string;
            encoding?: string;
            revision?: string;
            etag?: string;
          };
          const revision = asset.revision || app.revision || "";
          const tag = asset.etag || `"${revision}"`;
          const caching = {
            "Cache-Control":
              revision && url.searchParams.get("v") === revision
                ? "private, max-age=31536000, immutable"
                : "private, no-cache",
            ETag: tag,
            Vary: "Accept-Encoding",
          };
          if (asset.status === 304) {
            send(response, 304, undefined, asset.type, caching);
            return;
          }
          send(
            response,
            asset.status,
            head ? undefined : Buffer.from(asset.data, "base64"),
            asset.type,
            asset.status === 200
              ? {
                  ...caching,
                  ...(asset.encoding ? { "Content-Encoding": asset.encoding } : {}),
                }
              : {},
          );
          return;
        }
        const file = app.buildDir ? path.join(app.buildDir, url.pathname.slice(1)) : "";
        if (!file || !fs.existsSync(file)) {
          send(response, 404, "", "text/plain");
          return;
        }
        // The page links assets by revision, so a matching URL never changes.
        const tag = `"${app.revision}"`;
        const caching = {
          "Cache-Control":
            url.searchParams.get("v") === app.revision
              ? "private, max-age=31536000, immutable"
              : "private, no-cache",
          ETag: tag,
          Vary: "Accept-Encoding",
        };
        const type = url.pathname.endsWith(".css") ? "text/css" : "text/javascript";
        if (request.headers["if-none-match"] === tag) {
          send(response, 304, undefined, type, caching);
          return;
        }
        const accepted = encodings(request.headers["accept-encoding"]);
        const encoding = (
          [
            ["br", "br"],
            ["gzip", "gz"],
          ] as const
        ).find(([name, suffix]) => accepted.has(name) && appAsset(app, `${file}.${suffix}`));
        const data =
          request.method === "HEAD"
            ? ""
            : (appAsset(app, encoding ? `${file}.${encoding[1]}` : file) ?? "");
        send(response, 200, data, type, {
          ...caching,
          ...(encoding ? { "Content-Encoding": encoding[0] } : {}),
        });
        return;
      }
      const publicPath = app.hasPublic ? requestPublicPath(request.url) : undefined;
      if (publicPath) {
        const head = request.method === "HEAD";
        const ifNoneMatch = request.headers["if-none-match"];
        if (isPeerApp(app)) {
          const asset = await peers.call(app, "asset", {
            publicPath,
            head,
            ifNoneMatch,
          });
          if (asset instanceof Readable) {
            const incoming = asset as IncomingMessage;
            if (head || incoming.statusCode === 304) incoming.resume();
            await sendPublic(
              response,
              {
                stream: incoming,
                status: incoming.statusCode ?? 200,
                type: String(incoming.headers["content-type"] || "application/octet-stream"),
                etag: String(incoming.headers.etag || ""),
                size: String(incoming.headers["x-fleet-asset-size"] || "0"),
              },
              { head },
            );
            return;
          }
        } else {
          const asset = publicAsset(app, publicPath, ifNoneMatch);
          if (asset) {
            await sendPublic(response, asset, { head });
            return;
          }
        }
      }
      if (!app.hasClient) {
        send(
          response,
          200,
          servicePage(
            {
              name: app.name,
              revision: app.revision,
              operations: app.operations,
            },
            originFor("gate"),
          ),
        );
        return;
      }
      const hasCss = isPeerApp(app)
        ? app.hasCss
        : Boolean(app.buildDir && appAsset(app, path.join(app.buildDir, "app.css")));
      send(
        response,
        200,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${appHead(app)}${hasCss ? `<link rel="stylesheet" href="/app.css?v=${app.revision}">` : ""}</head><body><div id="app"></div>${clientErrorReporter}<script type="module" src="/app.js?v=${app.revision}"></script><script>const revision=${JSON.stringify(app.revision)};const events=new EventSource('/__fleet/events');window.__fleet={revision,events};events.onmessage=e=>{const state=JSON.parse(e.data);if(state.revision&&state.revision!==revision)location.reload()};</script></body></html>`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.log("daemon", message);
      if (response.headersSent) response.end();
      else if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        send(response, 503, unavailablePage(originFor("gate")));
      } else {
        json(response, 500, { error: message });
      }
    }
  }

  async function admin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname === "/health") {
        json(response, 200, { version: 2 });
        return;
      }
      if (
        setupToken &&
        url.pathname === `/setup/${setupToken}` &&
        Date.now() < setupExpires &&
        request.method === "GET"
      ) {
        const ticket = gate.ticket("gate.fleet", 600_000);
        phoneTickets.add(ticket);
        send(
          response,
          200,
          phoneSetupPage({
            profileUrl: `/setup/${setupToken}/fleet.mobileconfig`,
            openUrl: `${originFor("gate")}/phone?ticket=${ticket}`,
            fontUrl: `/setup/${setupToken}/geist-pixel-square.woff2`,
          }),
        );
        return;
      }
      if (
        setupToken &&
        url.pathname === `/setup/${setupToken}/geist-pixel-square.woff2` &&
        Date.now() < setupExpires &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const font = headingFont();
        if (!font) {
          send(response, 404, "", "text/plain");
          return;
        }
        send(response, 200, request.method === "HEAD" ? undefined : font, "font/woff2", {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Length": font.length,
        });
        return;
      }
      if (
        setupToken &&
        url.pathname === `/setup/${setupToken}/fleet.mobileconfig` &&
        Date.now() < setupExpires &&
        request.method === "GET"
      ) {
        send(response, 200, mobileProfile(home), "application/x-apple-aspen-config", {
          "Content-Disposition": 'attachment; filename="fleet.mobileconfig"',
        });
        return;
      }
      if (!sameSecret(request.headers.authorization, `Bearer ${config!.adminToken}`)) {
        json(response, 403, { error: "Local Fleet authorization required." });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/rpc") {
        json(response, 404, { error: "Not found." });
        return;
      }
      const { method, args = {} } = JSON.parse(await body(request)) as {
        method: string;
        args?: Record<string, unknown>;
      };
      if (method === "list") {
        json(response, 200, appList());
        return;
      }
      if (method === "invite") {
        json(response, 200, peers.invite({ ...config!, httpsPort }, authority(home).pem));
        return;
      }
      if (method === "peers") {
        json(response, 200, peers.computers());
        return;
      }
      if (method === "peerRemove") {
        const id = typeof args.id === "string" ? args.id : "";
        if (!/^[0-9a-f-]{36}$/i.test(id) || !peers.remove(id)) {
          json(response, 404, { error: "Unknown Fleet computer." });
          return;
        }
        json(response, 200, { removed: true, id });
        return;
      }
      if (method === "pair") {
        json(response, 200, { code: gate.pair() });
        return;
      }
      if (method === "browser") {
        const appName = typeof args.app === "string" ? args.app : "";
        if (appName && !routeExists(appName)) {
          json(response, 404, { error: "Unknown app or alias." });
          return;
        }
        json(response, 200, {
          url: `${originFor("gate")}/__fleet/claim?ticket=${gate.ticket("gate.fleet")}&app=${encodeURIComponent(appName)}`,
        });
        return;
      }
      if (method === "gateSessions") {
        json(response, 200, gate.sessions());
        return;
      }
      if (method === "gateRevoke") {
        const id = typeof args.id === "string" ? args.id : "";
        if (!/^[0-9a-f]{12}$/.test(id) || !gate.revoke(id)) {
          json(response, 404, { error: "Unknown Gate session." });
          return;
        }
        json(response, 200, { revoked: true, id });
        return;
      }
      if (method === "reset") {
        gate.reset();
        for (const client of eventClients) client.end();
        json(response, 200, { reset: true });
        return;
      }
      if (method === "setup") {
        phoneTickets.clear();
        phoneRouteClosed = true;
        setupToken = secret();
        setupExpires = Date.now() + 900_000;
        json(response, 200, {
          path: `/setup/${setupToken}`,
          expires: setupExpires,
        });
        return;
      }
      if (method === "inspect") {
        const app = appFor(String(args.app || ""));
        if (!app) {
          json(response, 404, { error: "Unknown app." });
          return;
        }
        if (args.wait === true && !isPeerApp(app)) await runtime.settleBuild(app);
        const current = appList().find((item) => item.id === app.id);
        if (!current) {
          json(response, 404, { error: "Unknown app." });
          return;
        }
        json(response, 200, inspectApp(current));
        return;
      }
      if (method === "emit") {
        const result = runtime.emitEvent("cli", args.topic as string, args.payload, 0, {
          notifyPeers: false,
        });
        const peerTargets =
          !result.dropped && config!.mode !== "node"
            ? forwardEventToPeers(
                {
                  id: result.eventId,
                  topic: result.topic,
                  source: result.source,
                  at: result.at,
                  depth: 0,
                },
                args.payload,
              )
            : [];
        if (!result.dropped && config!.mode === "node" && config!.gateway) {
          forwardEventToGateway(
            {
              id: result.eventId,
              topic: result.topic,
              source: result.source,
              at: result.at,
              depth: 0,
            },
            args.payload,
          );
        }
        json(response, 200, {
          ...result,
          matched: result.matched + peerTargets.length,
          targets: [...result.targets, ...peerTargets],
        });
        return;
      }
      if (method === "events") {
        const status = runtime.eventsStatus();
        const subscriptions: Array<{ pattern: string; app: string; peer?: string }> = [
          ...status.subscriptions,
        ];
        for (const peerApp of peers.list()) {
          for (const pattern of peerApp.operations.events || []) {
            subscriptions.push({ pattern, app: peerApp.name, peer: peerApp.peer });
          }
        }
        subscriptions.sort(
          (a, b) => a.pattern.localeCompare(b.pattern) || a.app.localeCompare(b.app),
        );
        json(response, 200, { ...status, subscriptions });
        return;
      }
      if (method === "call") {
        const app = appFor(String(args.app || ""));
        if (!app) {
          json(response, 404, { error: "Unknown app." });
          return;
        }
        const kind = args.kind as OperationKind;
        const name = String(args.name || "");
        const syntheticEvent =
          kind === "events"
            ? {
                id: randomUUID(),
                topic: name,
                source: "cli",
                at: new Date().toISOString(),
                depth: 0,
              }
            : undefined;
        json(
          response,
          200,
          isPeerApp(app)
            ? await peers.call(app, "call", args)
            : {
                value: await runtime.call(
                  app,
                  kind,
                  name,
                  args.input,
                  { id: "owner" },
                  undefined,
                  syntheticEvent,
                ),
              },
        );
        return;
      }
      json(response, 400, { error: "Unknown agent command." });
    } catch (error) {
      if (!response.headersSent) {
        json(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    for (const client of eventClients) client.end();
    if (announceTimer) clearInterval(announceTimer);
    await runtime.close();
    await Promise.all([...servers.map((s) => s.close()), ...dnsServers.map((s) => s.close())]);
    fs.rmSync(path.join(home, "running.json"), { force: true });
    unlock();
  };

  try {
    authority(home);
    const hosts = options.hosts || [...new Set(["127.0.0.1", ...(config.addresses || [])])];
    for (const host of config.mode === "node" ? [] : hosts) {
      const wrapped = createTlsHttpServer(
        {
          ...leaf(home, "gate.fleet"),
          minVersion: "TLSv1.2",
          SNICallback: (name, callback) => {
            const normalized = name.toLowerCase();
            if (!known(normalized)) {
              callback(new Error("Unknown Fleet app."));
              return;
            }
            try {
              callback(null, context(normalized));
            } catch (error) {
              callback(error instanceof Error ? error : new Error(String(error)));
            }
          },
        },
        (req, res) => {
          void handle(req, res);
        },
        { requestTimeout: 20_000, headersTimeout: 10_000 },
      );
      servers.push(wrapped);
      const bound = await listenNet(wrapped.server, options.httpsPort ?? httpsPort, host);
      if (!httpsPort || options.httpsPort === 0) httpsPort = bound;
      if (!options.noDns) {
        dnsServers.push(
          await startDNS({
            host,
            port: options.dnsPort ?? config.dnsPort ?? 53,
            addresses: config.addresses,
            names: () =>
              new Set([
                "gate.fleet",
                ...appList().map((app) => `${app.name}.fleet`),
                ...aliases().map((alias) => `${alias.name}.fleet`),
              ]),
          }),
        );
      }
    }
    const local = http.createServer((req, res) => {
      void admin(req, res);
    });
    servers.push(wrapHttpServer(local));
    local.requestTimeout = 15_000;
    const adminPort = await listenNet(
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
    if (config.mode === "node" && config.gateway) {
      const gateway = config.gateway;
      const node = createTlsHttpServer(
        { ...leaf(home, "gate.fleet"), minVersion: "TLSv1.2" },
        (request, response) => {
          void (async () => {
            try {
              if (
                request.method !== "POST" ||
                request.url !== "/node" ||
                !sameSecret(request.headers.authorization, `Bearer ${config.nodeToken}`)
              ) {
                json(response, 403, { error: "Fleet computer authorization required." });
                return;
              }
              const { method, args = {} } = JSON.parse(await body(request)) as {
                method: string;
                args?: Record<string, unknown>;
              };
              if (method === "probe") {
                json(response, 200, { id: config.nodeId });
                return;
              }
              if (method === "event") {
                const incoming = args.event as EventMeta | undefined;
                if (
                  !incoming ||
                  typeof incoming.id !== "string" ||
                  typeof incoming.source !== "string" ||
                  typeof incoming.at !== "string" ||
                  typeof incoming.depth !== "number" ||
                  !Number.isInteger(incoming.depth) ||
                  incoming.depth < 0 ||
                  incoming.depth > MAX_EVENT_DEPTH
                ) {
                  json(response, 400, { error: "Invalid peer event." });
                  return;
                }
                const topic = validateEventTopic(incoming.topic);
                json(
                  response,
                  200,
                  runtime.emitEvent(incoming.source, topic, args.payload, incoming.depth, {
                    notifyPeers: false,
                    eventId: incoming.id,
                    at: incoming.at,
                  }),
                );
                return;
              }
              const app = runtime.find(String(args.app || ""));
              if (!app) {
                json(response, 404, { error: "Unknown app on this computer." });
                return;
              }
              if (method === "call") {
                json(response, 200, {
                  value: await runtime.call(
                    app,
                    args.kind as OperationKind,
                    String(args.name || ""),
                    args.input,
                  ),
                });
                return;
              }
              if (method === "asset" && typeof args.publicPath === "string") {
                const asset = publicAsset(
                  app,
                  args.publicPath,
                  typeof args.ifNoneMatch === "string" ? args.ifNoneMatch : undefined,
                );
                if (!asset) {
                  json(response, 200, { status: 404 });
                  return;
                }
                await sendPublic(response, asset, {
                  head: args.head === true,
                  peer: true,
                });
                return;
              }
              if (method === "client-error") {
                const message = clientErrorMessage(args.message);
                if (!message) {
                  json(response, 400, { error: "Send a client error message." });
                  return;
                }
                runtime.log(app.id, `Client error: ${message}`);
                json(response, 200, { logged: true });
                return;
              }
              if (
                method === "asset" &&
                typeof args.file === "string" &&
                ["app.js", "app.css"].includes(args.file)
              ) {
                const type = args.file.endsWith(".css") ? "text/css" : "text/javascript";
                const revision = app.revision || "";
                const etag = `"${revision}"`;
                if (args.ifNoneMatch === etag) {
                  json(response, 200, { status: 304, type, data: "", revision, etag });
                  return;
                }
                const file = app.buildDir ? path.join(app.buildDir, args.file) : "";
                const requested =
                  args.encoding === "br" || args.encoding === "gzip" ? args.encoding : "";
                const suffix = requested === "br" ? "br" : requested === "gzip" ? "gz" : "";
                const compressed = suffix && file ? appAsset(app, `${file}.${suffix}`) : undefined;
                const data = compressed || (file ? appAsset(app, file) : undefined);
                json(response, 200, {
                  status: data ? 200 : 404,
                  type,
                  data: args.head === true ? "" : (data?.toString("base64") ?? ""),
                  ...(compressed ? { encoding: requested } : {}),
                  revision,
                  etag,
                });
                return;
              }
              json(response, 400, { error: "Unknown computer operation." });
            } catch (error) {
              if (response.headersSent) response.end();
              else {
                json(response, 500, {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          })();
        },
      );
      servers.push(node);
      const nodeHost = config.addresses.find((a) => a.includes(".")) || "127.0.0.1";
      const nodePort = await listenNet(
        node.server,
        options.nodePort ?? config.nodePort ?? 42174,
        nodeHost,
      );
      let announceAgain = false;
      const announce = async () => {
        if (closed) return;
        if (announcing) {
          announceAgain = true;
          return;
        }
        announcing = true;
        try {
          await peerRequest(
            {
              ...gateway,
              token: gateway.joinToken || config.nodeToken || "",
              route: "/__fleet/peers/register",
            },
            "register",
            {
              id: config.nodeId,
              address: nodeHost,
              port: nodePort,
              ca: authority(home).pem,
              token: config.nodeToken,
              apps: runtime.list(),
            },
          );
          if (gateway.joinToken) {
            delete gateway.joinToken;
            write(path.join(home, "config.json"), config);
          }
        } catch (error) {
          runtime.log(
            "daemon",
            `Computer registration: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          announcing = false;
          if (announceAgain) {
            announceAgain = false;
            void announce();
          }
        }
      };
      runtime.onData(() => {
        void announce();
      });
      announceTimer = setInterval(() => {
        void announce();
      }, 3000);
      announceTimer.unref();
      await runtime.tick();
      await runtime.settleBuilds();
      await runtime.tick();
      await announce();
    } else {
      await runtime.tick();
      await runtime.settleBuilds();
      await runtime.tick();
    }
    return { ...running, dnsPort: dnsServers[0]?.port, runtime, gate, close: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
