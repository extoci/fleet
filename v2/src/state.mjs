import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

export const root = () =>
  process.env.FLEET_V2_HOME || path.join(os.homedir(), ".fleet", "v2");
export const read = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};
export function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(
      temp,
      typeof value === "string" || ArrayBuffer.isView(value)
        ? value
        : JSON.stringify(value, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function configuration(home = root()) {
  return read(path.join(home, "config.json"), null);
}
export function validateName(name) {
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
export function manifest(directory) {
  const app = read(path.join(directory, "fleet.json"), null);
  if (!app || app.version !== 2)
    throw new Error(`No Fleet v2 app in ${directory}. Run fleet init.`);
  validateName(app.name);
  if (!/^[0-9a-f-]{36}$/i.test(app.id))
    throw new Error("Invalid app ID in fleet.json.");
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
    throw new Error(
      "Each job needs a name and an everySeconds interval of at least 5.",
    );
  }
  return app;
}
export function headMetadata(value) {
  return Object.fromEntries(
    ["title", "themeColor", "icon", "manifest"]
      .filter((key) => typeof value?.[key] === "string")
      .map((key) => [key, value[key]]),
  );
}
export function register(home, directory) {
  return withStateLock(home, () => registerUnlocked(home, directory));
}
export function withStateLock(home, operation) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, "registry.lock");
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = read(path.join(lock, "pid.json"), null);
      if (owner) {
        try {
          process.kill(owner, 0);
        } catch (e) {
          if (e.code === "ESRCH") {
            fs.rmSync(lock, { recursive: true, force: true });
            continue;
          }
        }
      }
      if (Date.now() >= deadline)
        throw new Error(
          "Another Fleet command is updating the registry. Retry shortly.",
        );
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
function registerUnlocked(home, directory) {
  directory = fs.realpathSync(directory);
  const app = manifest(directory);
  const file = path.join(home, "apps.json");
  const apps = read(file, []);
  if (
    read(path.join(home, "peers.json"), []).some((peer) =>
      peer.apps.some((a) => a.name === app.name),
    )
  )
    throw new Error(`${app.name} is registered on another Fleet computer.`);
  const namesFile = path.join(home, "names.json");
  const names = read(namesFile, {});
  if (names[app.name] && names[app.name] !== app.id)
    throw new Error(
      `${app.name} belongs to a previous app. Choose a new name to keep browser data separate.`,
    );
  const conflict = apps.find(
    (a) =>
      (a.name === app.name || a.id === app.id) && a.directory !== directory,
  );
  if (conflict)
    throw new Error(
      `${app.name} is already registered from ${conflict.directory}.`,
    );
  const next = apps.filter((a) => a.directory !== directory);
  next.push({ ...app, directory });
  names[app.name] = app.id;
  write(namesFile, names);
  write(file, next);
  return app;
}
export function hostname(authority = "") {
  // Only ASCII DNS names are valid app authorities. Never accept credentials,
  // URLs, duplicate authorities, or an arbitrary destination.
  const match = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(authority);
  return match ? match[1].toLowerCase().replace(/\.$/, "") : "";
}
export const secret = () => randomBytes(32).toString("base64url");
export function acquire(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, "daemon.lock");
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = read(path.join(lock, "pid.json"), null);
    try {
      if (pid) {
        process.kill(pid, 0);
        throw new Error("Fleet is already running.");
      }
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    if (!pid)
      throw new Error(
        "Fleet has an incomplete daemon lock. Check for a running daemon before removing it.",
      );
    fs.rmSync(lock, { recursive: true });
    fs.mkdirSync(lock);
  }
  write(path.join(lock, "pid.json"), process.pid);
  return () => fs.rmSync(lock, { recursive: true, force: true });
}
