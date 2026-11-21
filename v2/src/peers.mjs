import https from "node:https";
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  read,
  write,
  secret,
  validateName,
  withStateLock,
  headMetadata,
} from "./state.mjs";
import { sameSecret } from "./gate.mjs";

export function privateAddress(address) {
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
export function peerRequest(target, method, args = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ method, args });
    const request = https.request(
      {
        host: target.address,
        port: target.port,
        servername: "gate.fleet",
        ca: target.ca,
        path: target.route || "/node",
        method: "POST",
        headers: {
          Host: "gate.fleet",
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (response) => {
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
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 8_000_000)
            request.destroy(new Error("Fleet peer response exceeds 8 MB."));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString());
            if (response.statusCode !== 200)
              reject(
                new Error(result.error || "Fleet peer refused the request."),
              );
            else resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(35_000, () =>
      request.destroy(
        new Error(
          "The app computer is not reachable or its request timed out.",
        ),
      ),
    );
    request.on("error", reject);
    request.end(data);
  });
}
export class Peers {
  constructor(home, runtime, { allowLoopback = false } = {}) {
    this.home = home;
    this.runtime = runtime;
    this.allowLoopback = allowLoopback;
    this.pending = new Map();
  }
  all() {
    return read(path.join(this.home, "peers.json"), []);
  }
  list() {
    return this.all().flatMap((peer) =>
      peer.apps.map((app) => ({
        ...app,
        peer: peer.id,
        directory: "(another Fleet computer)",
        online: Date.now() - peer.seen < 15_000,
      })),
    );
  }
  find(name) {
    return this.list().find((app) => app.name === name);
  }
  invite(config, ca) {
    const token = secret();
    const file = path.join(this.home, "node-invites.json");
    const invites = read(file, {});
    for (const [key, value] of Object.entries(invites))
      if (value < Date.now()) delete invites[key];
    invites[createHash("sha256").update(token).digest("hex")] =
      Date.now() + 600_000;
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
  async announce(token, info) {
    if (
      !info ||
      (!privateAddress(info.address) &&
        !(this.allowLoopback && info.address === "127.0.0.1"))
    )
      throw new Error("A Fleet app computer must use a Tailscale address.");
    if (
      !/^[0-9a-f-]{36}$/i.test(info.id) ||
      !Number.isInteger(info.port) ||
      info.port < 1024 ||
      info.port > 65535 ||
      typeof info.ca !== "string" ||
      info.ca.length > 10000 ||
      typeof info.token !== "string" ||
      info.token.length < 32
    )
      throw new Error("Invalid Fleet computer registration.");
    if (!Array.isArray(info.apps) || info.apps.length > 256)
      throw new Error("Invalid app registry.");
    const peers = this.all();
    const old = peers.find((p) => p.id === info.id);
    let inviteKey;
    if (old) {
      if (
        !sameSecret(token, old.token) ||
        info.ca !== old.ca ||
        !sameSecret(info.token, old.token)
      )
        throw new Error(
          "Fleet computer identity changed. Remove it and enroll again.",
        );
    } else {
      inviteKey = createHash("sha256")
        .update(token || "")
        .digest("hex");
      const invites = read(path.join(this.home, "node-invites.json"), {});
      if (!invites[inviteKey] || invites[inviteKey] < Date.now())
        throw new Error("The computer invitation is invalid or expired.");
      if (this.pending.has(inviteKey))
        throw new Error("This invitation is already in use.");
      this.pending.set(inviteKey, true);
    }
    try {
      const apps = info.apps.map((a) => ({
        id: a.id,
        name: validateName(a.name),
        revision: a.revision || null,
        running: Boolean(a.running),
        error: a.error || null,
        head: headMetadata(a.head),
        hasPublic: a.hasPublic === true,
      }));
      const occupied = new Set([
        ...this.runtime.list().map((a) => a.name),
        ...peers
          .filter((p) => p.id !== info.id)
          .flatMap((p) => p.apps.map((a) => a.name)),
      ]);
      for (const app of apps) {
        if (occupied.has(app.name))
          throw new Error(
            `The app name ${app.name} is already in use on another computer.`,
          );
        occupied.add(app.name);
      }
      const target = {
        address: info.address,
        port: info.port,
        ca: info.ca,
        token: info.token,
      };
      await peerRequest(target, "probe");
      withStateLock(this.home, () => {
        const latest = this.all();
        const namesFile = path.join(this.home, "names.json");
        const names = read(namesFile, {});
        const occupiedNow = new Set([
          ...this.runtime.list().map((a) => a.name),
          ...latest
            .filter((p) => p.id !== info.id)
            .flatMap((p) => p.apps.map((a) => a.name)),
        ]);
        for (const app of apps) {
          if (
            !/^[0-9a-f-]{36}$/i.test(app.id) ||
            occupiedNow.has(app.name) ||
            (names[app.name] && names[app.name] !== app.id)
          )
            throw new Error(
              `The app name ${app.name} already belongs to another app. Choose a new name.`,
            );
          names[app.name] = app.id;
        }
        write(namesFile, names);
        write(path.join(this.home, "peers.json"), [
          ...latest.filter((p) => p.id !== info.id),
          { id: info.id, ...target, apps, seen: Date.now() },
        ]);
      });
      if (inviteKey) {
        const invites = read(path.join(this.home, "node-invites.json"), {});
        delete invites[inviteKey];
        write(path.join(this.home, "node-invites.json"), invites);
      }
      return { registered: true };
    } finally {
      if (inviteKey) this.pending.delete(inviteKey);
    }
  }
  async call(app, method, args = {}) {
    const peer = this.all().find((p) => p.id === app.peer);
    if (!peer) throw new Error("The app computer was removed.");
    return peerRequest(peer, method, { ...args, app: app.name });
  }
}
