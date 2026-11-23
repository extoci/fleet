import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { operationKinds } from "./app-definition.ts";
import { sameSecret } from "./gate.ts";
import type { Runtime } from "./runtime.ts";
import {
  type FleetConfig,
  type HeadMetadata,
  headMetadata,
  read,
  readShared,
  secret,
  validateName,
  withStateLock,
  write,
} from "./state.ts";

export interface PeerTarget {
  address: string;
  port: number;
  ca: string;
  token: string;
  route?: string;
}

export interface PeerAppRecord {
  id: string;
  name: string;
  revision: string | null;
  running: boolean;
  error: string | null;
  head: HeadMetadata;
  hasPublic: boolean;
  operations: Record<string, string[]>;
}

export interface PeerRecord extends PeerTarget {
  id: string;
  apps: PeerAppRecord[];
  seen: number;
}

export interface PeerAppView extends PeerAppRecord {
  peer: string;
  directory: string;
  online: boolean;
}

export function privateAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  if (net.isIP(address) === 6) return /^fd7a:115c:a1e0:/i.test(address);
  if (net.isIP(address) !== 4) return false;
  const parts = address.split(".");
  return (
    parts.length === 4 &&
    parts.every((v) => /^\d{1,3}$/.test(v) && Number(v) <= 255) &&
    +parts[0] === 100 &&
    +parts[1] >= 64 &&
    +parts[1] <= 127
  );
}

// Reuse TLS connections between computers — a fresh handshake per call costs
// more than the call itself on a tailnet.
const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000 });

export function peerRequest(
  target: PeerTarget,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ method, args });
    const request = https.request(
      {
        host: target.address,
        port: target.port,
        servername: "gate.fleet",
        ca: target.ca,
        agent,
        path: target.route || "/node",
        method: "POST",
        headers: {
          Host: "gate.fleet",
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (response: IncomingMessage) => {
        response.on("error", reject);
        if (
          method === "asset" &&
          args.publicPath &&
          response.headers["x-fleet-public-asset"] === "1"
        ) {
          resolve(response);
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8_000_000) {
            request.destroy(new Error("Fleet peer response exceeds 8 MB."));
          } else {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString()) as { error?: string };
            if (response.statusCode !== 200) {
              reject(new Error(result.error || "Fleet peer refused the request."));
            } else {
              resolve(result);
            }
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(35_000, () =>
      request.destroy(new Error("The app computer is not reachable or its request timed out.")),
    );
    request.on("error", reject);
    request.end(data);
  });
}

export class Peers {
  home: string;
  runtime: Runtime;
  allowLoopback: boolean;
  pending: Map<string, boolean>;

  constructor(home: string, runtime: Runtime, { allowLoopback = false } = {}) {
    this.home = home;
    this.runtime = runtime;
    this.allowLoopback = allowLoopback;
    this.pending = new Map();
  }

  all(): PeerRecord[] {
    return readShared<PeerRecord[]>(path.join(this.home, "peers.json"), []);
  }

  list(): PeerAppView[] {
    return this.all().flatMap((peer) =>
      peer.apps.map((app) => ({
        ...app,
        peer: peer.id,
        directory: "(another Fleet computer)",
        online: Date.now() - peer.seen < 15_000,
      })),
    );
  }

  find(name: string): PeerAppView | undefined {
    return this.list().find((app) => app.name === name);
  }

  invite(config: Pick<FleetConfig, "addresses" | "httpsPort">, ca: string) {
    const token = secret();
    const file = path.join(this.home, "node-invites.json");
    const invites = read<Record<string, number>>(file, {});
    for (const [key, value] of Object.entries(invites)) {
      if (value < Date.now()) delete invites[key];
    }
    invites[createHash("sha256").update(token).digest("hex")] = Date.now() + 600_000;
    write(file, invites);
    return {
      version: 2,
      address: config.addresses.find((a) => a.includes(".")),
      port: config.httpsPort,
      ca,
      token,
      expires: Date.now() + 600_000,
    };
  }

  async announce(token: string | undefined, info: Record<string, unknown>) {
    if (
      !info ||
      (!privateAddress(info.address) && !(this.allowLoopback && info.address === "127.0.0.1"))
    ) {
      throw new Error("A Fleet app computer must use a Tailscale address.");
    }
    if (
      typeof info.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(info.id) ||
      typeof info.port !== "number" ||
      !Number.isInteger(info.port) ||
      info.port < 1024 ||
      info.port > 65535 ||
      typeof info.ca !== "string" ||
      info.ca.length > 10000 ||
      typeof info.token !== "string" ||
      info.token.length < 32
    ) {
      throw new Error("Invalid Fleet computer registration.");
    }
    if (!Array.isArray(info.apps) || info.apps.length > 256) {
      throw new Error("Invalid app registry.");
    }
    const peerId = info.id;
    const peerAddress = info.address as string;
    const peerPort = info.port;
    const peerCa = info.ca;
    const peerToken = info.token;
    const peers = this.all();
    const old = peers.find((p) => p.id === peerId);
    let inviteKey: string | undefined;
    if (old) {
      if (!sameSecret(token, old.token) || peerCa !== old.ca || !sameSecret(peerToken, old.token)) {
        throw new Error("Fleet computer identity changed. Remove it and enroll again.");
      }
    } else {
      inviteKey = createHash("sha256")
        .update(token || "")
        .digest("hex");
      const invites = read<Record<string, number>>(path.join(this.home, "node-invites.json"), {});
      if (!invites[inviteKey] || invites[inviteKey] < Date.now()) {
        throw new Error("The computer invitation is invalid or expired.");
      }
      if (this.pending.has(inviteKey)) {
        throw new Error("This invitation is already in use.");
      }
      this.pending.set(inviteKey, true);
    }
    try {
      const apps: PeerAppRecord[] = (info.apps as Array<Record<string, unknown>>).map((a) => ({
        id: String(a.id || ""),
        name: validateName(String(a.name || "")),
        revision: typeof a.revision === "string" ? a.revision : null,
        running: Boolean(a.running),
        error: typeof a.error === "string" ? a.error : null,
        head: headMetadata(a.head),
        hasPublic: a.hasPublic === true,
        operations: Object.fromEntries(
          operationKinds
            .filter((kind) =>
              Array.isArray((a.operations as Record<string, unknown> | undefined)?.[kind]),
            )
            .map((kind) => [
              kind,
              ((a.operations as Record<string, unknown[]>)[kind] || []).filter(
                (name): name is string => typeof name === "string",
              ),
            ]),
        ),
      }));
      const occupied = new Set([
        ...this.runtime.list().map((a) => a.name),
        ...peers.filter((p) => p.id !== peerId).flatMap((p) => p.apps.map((a) => a.name)),
      ]);
      for (const app of apps) {
        if (occupied.has(app.name)) {
          throw new Error(`The app name ${app.name} is already in use on another computer.`);
        }
        occupied.add(app.name);
      }
      const target: PeerTarget = {
        address: peerAddress,
        port: peerPort,
        ca: peerCa,
        token: peerToken,
      };
      await peerRequest(target, "probe");
      withStateLock(this.home, () => {
        const latest = this.all();
        const namesFile = path.join(this.home, "names.json");
        const names = read<Record<string, string>>(namesFile, {});
        const occupiedNow = new Set([
          ...this.runtime.list().map((a) => a.name),
          ...latest.filter((p) => p.id !== peerId).flatMap((p) => p.apps.map((a) => a.name)),
        ]);
        for (const app of apps) {
          if (
            !/^[0-9a-f-]{36}$/i.test(app.id) ||
            occupiedNow.has(app.name) ||
            (names[app.name] && names[app.name] !== app.id)
          ) {
            throw new Error(
              `The app name ${app.name} already belongs to another app. Choose a new name.`,
            );
          }
          names[app.name] = app.id;
        }
        write(namesFile, names);
        write(path.join(this.home, "peers.json"), [
          ...latest.filter((p) => p.id !== peerId),
          { id: peerId, ...target, apps, seen: Date.now() },
        ]);
      });
      if (inviteKey) {
        const invites = read<Record<string, number>>(path.join(this.home, "node-invites.json"), {});
        delete invites[inviteKey];
        write(path.join(this.home, "node-invites.json"), invites);
      }
      return { registered: true };
    } finally {
      if (inviteKey) this.pending.delete(inviteKey);
    }
  }

  async call(app: PeerAppView, method: string, args: Record<string, unknown> = {}) {
    const peer = this.all().find((p) => p.id === app.peer);
    if (!peer) throw new Error("The app computer was removed.");
    return peerRequest(peer, method, { ...args, app: app.name });
  }
}
