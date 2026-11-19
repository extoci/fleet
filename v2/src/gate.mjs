import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { read, write, secret } from "./state.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const sameSecret = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
const cookieName = "__Host-fleet";
export class Gate {
  constructor(home) {
    this.file = path.join(home, "gate.json");
    this.state = read(this.file, { codes: {}, sessions: {} });
    this.tickets = new Map();
    this.attempts = new Map();
    this.prune();
  }
  prune() {
    const now = Date.now();
    for (const collection of [this.state.codes, this.state.sessions])
      for (const [key, value] of Object.entries(collection))
        if (value.expires <= now) delete collection[key];
    for (const [key, value] of this.tickets)
      if (value.expires <= now) this.tickets.delete(key);
    for (const [key, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(key);
  }
  save() {
    this.prune();
    write(this.file, this.state);
  }
  pair() {
    this.prune();
    if (Object.keys(this.state.codes).length >= 20)
      throw new Error("Too many unused pairing codes. Wait ten minutes.");
    const code = randomBytes(6).toString("hex").toUpperCase();
    this.state.codes[digest(code)] = { expires: Date.now() + 600_000 };
    this.save();
    return code;
  }
  redeem(code, peer) {
    this.prune();
    const attempt = this.attempts.get(peer) || {
      count: 0,
      until: Date.now() + 900_000,
    };
    if (++attempt.count > 10 || this.attempts.size > 4096) return false;
    this.attempts.set(peer, attempt);
    const key = digest(String(code).replace(/[-\s]/g, "").toUpperCase());
    const grant = this.state.codes[key];
    if (!grant || grant.expires <= Date.now()) return false;
    delete this.state.codes[key];
    this.save();
    return true;
  }
  session(host) {
    this.prune();
    if (Object.keys(this.state.sessions).length >= 2048)
      throw new Error(
        "Device session limit reached. Revoke old sessions with fleet gate reset.",
      );
    const token = secret();
    this.state.sessions[digest(token)] = {
      host,
      expires: Date.now() + 30 * 86400_000,
    };
    this.save();
    return {
      token,
      cookie: `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    };
  }
  authorized(request, host) {
    const token = request.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!token || token.length > 128) return false;
    const session = this.state.sessions[digest(token)];
    return Boolean(
      session && session.host === host && session.expires > Date.now(),
    );
  }
  ticket(host, lifetime = 30_000) {
    this.prune();
    if (this.tickets.size >= 2048)
      throw new Error("Too many pending sign-ins.");
    const token = secret();
    this.tickets.set(digest(token), { host, expires: Date.now() + lifetime });
    return token;
  }
  claim(token, host) {
    if (!token || token.length > 128) return false;
    const key = digest(token);
    const grant = this.tickets.get(key);
    this.tickets.delete(key);
    return Boolean(grant && grant.host === host && grant.expires > Date.now());
  }
  reset() {
    this.state = { codes: {}, sessions: {} };
    this.tickets.clear();
    this.save();
  }
}
