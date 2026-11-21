import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface JobSpec {
  name: string;
  everySeconds: number;
}

export interface HeadMetadata {
  title?: string;
  themeColor?: string;
  icon?: string;
  manifest?: string;
}

export interface AppManifest extends HeadMetadata {
  version: 2;
  id: string;
  name: string;
  jobs?: JobSpec[];
}

export interface RegisteredApp extends AppManifest {
  directory: string;
}

export interface GatewayConfig {
  address: string;
  port: number;
  ca: string;
  joinToken?: string;
}

export interface FleetConfig {
  version: 2;
  addresses: string[];
  dnsName?: string;
  userId?: number;
  httpsPort: number;
  dnsPort: number;
  adminPort: number;
  adminToken: string;
  mode?: "node";
  nodeId?: string;
  nodeToken?: string;
  nodePort?: number;
  gateway?: GatewayConfig;
}

export interface RunningInfo {
  pid: number;
  httpsPort: number;
  adminPort: number;
  setupPath: string;
  started: string;
}

export const root = (): string =>
  process.env.FLEET_V2_HOME || process.env.FLEET_HOME || path.join(os.homedir(), ".fleet", "v2");

export const read = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
};

export function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      typeof value === "string" || ArrayBuffer.isView(value)
        ? (value as string | NodeJS.ArrayBufferView)
        : JSON.stringify(value, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function configuration(home = root()): FleetConfig | null {
  return read<FleetConfig | null>(path.join(home, "config.json"), null);
}

export function validateName(name: string): string {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ||
    ["gate", "setup", "www"].includes(name)
  ) {
    throw new Error(
      "Use a name with lowercase letters, digits, and interior hyphens. gate, setup, and www are reserved.",
    );
  }
  return name;
}

export function manifest(directory: string): AppManifest {
  const app = read<AppManifest | null>(path.join(directory, "fleet.json"), null);
  if (!app || app.version !== 2) {
    throw new Error(`No Fleet app in ${directory}. Run fleet init.`);
  }
  validateName(app.name);
  if (!/^[0-9a-f-]{36}$/i.test(app.id)) {
    throw new Error("Invalid app ID in fleet.json.");
  }
  if (
    app.jobs &&
    (!Array.isArray(app.jobs) ||
      app.jobs.some(
        (j) =>
          !/^[a-zA-Z][\w-]{0,63}$/.test(j.name) ||
          !Number.isInteger(j.everySeconds) ||
          j.everySeconds < 5,
      ))
  ) {
    throw new Error("Each job needs a name and an everySeconds interval of at least 5.");
  }
  return app;
}

export function headMetadata(value: unknown): HeadMetadata {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    (["title", "themeColor", "icon", "manifest"] as const)
      .filter((key) => typeof source[key] === "string")
      .map((key) => [key, source[key] as string]),
  );
}

export function register(home: string, directory: string): AppManifest {
  return withStateLock(home, () => registerUnlocked(home, directory));
}

export function withStateLock<T>(home: string, operation: () => T): T {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, "registry.lock");
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = read<number | null>(path.join(lock, "pid.json"), null);
      if (owner) {
        try {
          process.kill(owner, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("Another Fleet command is updating the registry. Retry shortly.", {
          cause: error,
        });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    write(path.join(lock, "pid.json"), process.pid);
    return operation();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function registerUnlocked(home: string, directory: string): AppManifest {
  directory = fs.realpathSync(directory);
  const app = manifest(directory);
  const file = path.join(home, "apps.json");
  const apps = read<RegisteredApp[]>(file, []);
  const peers = read<Array<{ apps: Array<{ name: string }> }>>(path.join(home, "peers.json"), []);
  if (peers.some((peer) => peer.apps.some((a) => a.name === app.name))) {
    throw new Error(`${app.name} is registered on another Fleet computer.`);
  }
  const namesFile = path.join(home, "names.json");
  const names = read<Record<string, string>>(namesFile, {});
  if (names[app.name] && names[app.name] !== app.id) {
    throw new Error(
      `${app.name} belongs to a previous app. Choose a new name to keep browser data separate.`,
    );
  }
  const conflict = apps.find(
    (a) => (a.name === app.name || a.id === app.id) && a.directory !== directory,
  );
  if (conflict) {
    throw new Error(`${app.name} is already registered from ${conflict.directory}.`);
  }
  const next = apps.filter((a) => a.directory !== directory);
  next.push({ ...app, directory });
  names[app.name] = app.id;
  write(namesFile, names);
  write(file, next);
  return app;
}

export function hostname(authority = ""): string {
  // Only ASCII DNS names are valid app authorities. Never accept credentials,
  // URLs, duplicate authorities, or an arbitrary destination.
  const match = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(authority);
  return match ? match[1].toLowerCase().replace(/\.$/, "") : "";
}

export const secret = (): string => randomBytes(32).toString("base64url");

export function acquire(home: string): () => void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, "daemon.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = read<number | null>(path.join(lock, "pid.json"), null);
    try {
      if (pid) {
        process.kill(pid, 0);
        throw new Error("Fleet is already running.", { cause: error });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    if (!pid) {
      throw new Error(
        "Fleet has an incomplete daemon lock. Check for a running daemon before removing it.",
        { cause: error },
      );
    }
    fs.rmSync(lock, { recursive: true });
    fs.mkdirSync(lock);
  }
  write(path.join(lock, "pid.json"), process.pid);
  return () => fs.rmSync(lock, { recursive: true, force: true });
}
