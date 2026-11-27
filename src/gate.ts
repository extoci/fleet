import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { read, secret, write } from "./state.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export const sameSecret = (a: unknown, b: unknown): boolean =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const cookieName = "__Host-fleet";

export interface GateSessionInfo {
  id: string;
  host: string;
  createdAt: string;
  lastSeen: string;
  userAgent: string;
}

interface StoredGateSession extends Partial<GateSessionInfo> {
  host: string;
  expires: number;
}

interface GateState {
  codes: Record<string, { expires: number }>;
  sessions: Record<string, StoredGateSession>;
}

function userAgentSummary(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "Unknown device";
  const ua = Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return code > 31 && code !== 127;
    })
    .join("")
    .slice(0, 512);
  const system = /iphone/i.test(ua)
    ? "iPhone"
    : /ipad/i.test(ua)
      ? "iPad"
      : /android/i.test(ua)
        ? "Android"
        : /mac os x|macintosh/i.test(ua)
          ? "macOS"
          : /windows/i.test(ua)
            ? "Windows"
            : /linux/i.test(ua)
              ? "Linux"
              : "unknown system";
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /firefox\//i.test(ua)
      ? "Firefox"
      : /(?:chrome|chromium)\//i.test(ua)
        ? "Chrome"
        : /safari\//i.test(ua)
          ? "Safari"
          : "Browser";
  return `${browser} on ${system}`.slice(0, 80);
}

export class Gate {
  file: string;
  state: GateState;
  tickets: Map<string, { host: string; expires: number }>;
  attempts: Map<string, { count: number; until: number }>;

  constructor(home: string) {
    this.file = path.join(home, "gate.json");
    this.state = read<GateState>(this.file, { codes: {}, sessions: {} });
    this.tickets = new Map();
    this.attempts = new Map();
    this.prune();
  }

  prune(): void {
    const now = Date.now();
    for (const collection of [this.state.codes, this.state.sessions]) {
      for (const [key, value] of Object.entries(collection)) {
        if (value.expires <= now) delete collection[key];
      }
    }
    for (const [key, value] of this.tickets) {
      if (value.expires <= now) this.tickets.delete(key);
    }
    for (const [key, value] of this.attempts) {
      if (value.until <= now) this.attempts.delete(key);
    }
  }

  save(): void {
    this.prune();
    write(this.file, this.state);
  }

  pair(): string {
    this.prune();
    if (Object.keys(this.state.codes).length >= 20) {
      throw new Error("Too many unused pairing codes. Wait ten minutes.");
    }
    const code = randomBytes(6).toString("hex").toUpperCase();
    this.state.codes[digest(code)] = { expires: Date.now() + 600_000 };
    this.save();
    return code;
  }

  redeem(code: string | null, peer: string | undefined): boolean {
    this.prune();
    const peerKey = peer || "unknown";
    const attempt = this.attempts.get(peerKey) || {
      count: 0,
      until: Date.now() + 900_000,
    };
    if (++attempt.count > 10 || this.attempts.size > 4096) return false;
    this.attempts.set(peerKey, attempt);
    const key = digest(
      String(code || "")
        .replace(/[-\s]/g, "")
        .toUpperCase(),
    );
    const grant = this.state.codes[key];
    if (!grant || grant.expires <= Date.now()) return false;
    delete this.state.codes[key];
    this.save();
    return true;
  }

  session(host: string, userAgent?: string): { token: string; cookie: string } {
    this.prune();
    if (Object.keys(this.state.sessions).length >= 2048) {
      throw new Error("Device session limit reached. Revoke old sessions with fleet gate reset.");
    }
    const token = secret();
    const key = digest(token);
    const now = new Date().toISOString();
    this.state.sessions[key] = {
      id: key.slice(0, 12),
      host,
      createdAt: now,
      lastSeen: now,
      userAgent: userAgentSummary(userAgent),
      expires: Date.now() + 30 * 86400_000,
    };
    this.save();
    return {
      token,
      cookie: `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    };
  }

  token(request: IncomingMessage): string | null {
    const token = request.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    return token && token.length <= 128 ? token : null;
  }

  normalizeSession(key: string, session: StoredGateSession): boolean {
    let changed = false;
    if (!session.id) {
      session.id = key.slice(0, 12);
      changed = true;
    }
    if (!session.createdAt) {
      session.createdAt = new Date().toISOString();
      changed = true;
    }
    if (!session.lastSeen) {
      session.lastSeen = session.createdAt;
      changed = true;
    }
    if (!session.userAgent) {
      session.userAgent = "Unknown device";
      changed = true;
    }
    return changed;
  }

  authorized(request: IncomingMessage, host: string): boolean {
    const token = this.token(request);
    if (!token) return false;
    const key = digest(token);
    const session = this.state.sessions[key];
    if (!session || session.host !== host || session.expires <= Date.now()) return false;
    const migrated = this.normalizeSession(key, session);
    const lastSeen = Date.parse(session.lastSeen || "");
    if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > 60_000) {
      session.lastSeen = new Date().toISOString();
      this.save();
    } else if (migrated) {
      this.save();
    }
    return true;
  }

  sessions(): GateSessionInfo[] {
    let migrated = false;
    const sessions: GateSessionInfo[] = [];
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (session.expires <= Date.now()) continue;
      migrated = this.normalizeSession(key, session) || migrated;
      sessions.push({
        id: session.id!,
        host: session.host,
        createdAt: session.createdAt!,
        lastSeen: session.lastSeen!,
        userAgent: session.userAgent!,
      });
    }
    if (migrated) this.save();
    return sessions.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  revoke(id: string): boolean {
    let changed = false;
    for (const [key, session] of Object.entries(this.state.sessions)) {
      this.normalizeSession(key, session);
      if (session.id === id) {
        delete this.state.sessions[key];
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  revokeRequest(request: IncomingMessage): boolean {
    const token = this.token(request);
    if (!token) return false;
    const key = digest(token);
    if (!this.state.sessions[key]) return false;
    delete this.state.sessions[key];
    this.save();
    return true;
  }

  ticket(host: string, lifetime = 30_000): string {
    this.prune();
    if (this.tickets.size >= 2048) {
      throw new Error("Too many pending sign-ins.");
    }
    const token = secret();
    this.tickets.set(digest(token), { host, expires: Date.now() + lifetime });
    return token;
  }

  claim(token: string | null, host: string): boolean {
    if (!token || token.length > 128) return false;
    const key = digest(token);
    const grant = this.tickets.get(key);
    this.tickets.delete(key);
    return Boolean(grant && grant.host === host && grant.expires > Date.now());
  }

  reset(): void {
    this.state = { codes: {}, sessions: {} };
    this.tickets.clear();
    this.save();
  }
}
