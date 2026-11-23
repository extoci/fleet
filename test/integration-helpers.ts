import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach } from "bun:test";
import { authority } from "../src/certificates.ts";
import { type StartOptions, start } from "../src/server.ts";
import { secret, write } from "../src/state.ts";

export const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const exec = promisify(execFile);

export const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

export async function runCli<T = Record<string, unknown>>(
  home: string,
  ...args: string[]
): Promise<T> {
  const { stdout } = await exec(process.execPath, [cli, "--home", home, ...args, "--json"], {
    timeout: 10_000,
  });
  return JSON.parse(stdout) as T;
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(
  check: () => unknown | Promise<unknown>,
  timeout = 10000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(40);
  }
  throw new Error("Condition did not become true.");
}

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  raw: Buffer;
  text: string;
}

export function request(
  daemon: { httpsPort: number },
  ca: string,
  host: string,
  route = "/",
  {
    method = "GET",
    data,
    cookie,
    origin = `https://${host}:${daemon.httpsPort}`,
    headers = {},
  }: {
    method?: string;
    data?: string;
    cookie?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: daemon.httpsPort,
        servername: host,
        ca,
        path: route,
        method,
        headers: {
          Host: `${host}:${daemon.httpsPort}`,
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
          ...(data !== undefined
            ? {
                "Content-Type": route.startsWith("/__fleet/login")
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            raw,
            text: raw.toString(),
          });
        });
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error("Test request timed out.")));
    req.on("error", reject);
    req.end(data);
  });
}

export async function fixture(daemonOptions: StartOptions = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-test-"));
  const project = path.join(home, "notes");
  execFileSync(process.execPath, [cli, "init", project, "--json"], {
    env: { ...process.env, FLEET_V2_HOME: home },
    stdio: "pipe",
  });
  write(path.join(home, "config.json"), {
    version: 2,
    addresses: ["127.0.0.1"],
    adminToken: secret(),
    httpsPort: 0,
    dnsPort: 0,
    adminPort: 0,
  });
  const daemon = await start(home, {
    hosts: ["127.0.0.1"],
    httpsPort: 0,
    adminPort: 0,
    noDns: true,
    idleMs: 100,
    pollMs: 50,
    ...daemonOptions,
  });
  cleanups.push(async () => {
    await daemon.close();
    await wait(100);
    fs.rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  return { home, project, daemon, ca: authority(home).pem };
}

export async function signin(
  daemon: Awaited<ReturnType<typeof start>>,
  ca: string,
  name = "notes",
  gateCookie?: string,
) {
  if (!gateCookie) {
    const response = await request(daemon, ca, "gate.fleet", `/__fleet/login?app=${name}`, {
      method: "POST",
      data: `code=${daemon.gate.pair()}`,
    });
    assert.equal(response.status, 303);
    gateCookie = response.headers["set-cookie"]?.[0].split(";")[0];
  }
  const login = await request(daemon, ca, "gate.fleet", `/__fleet/login?app=${name}`, {
    cookie: gateCookie,
  });
  assert.equal(login.status, 303);
  const location = login.headers.location!;
  const claim = await request(
    daemon,
    ca,
    `${name}.fleet`,
    new URL(location).pathname + new URL(location).search,
  );
  assert.equal(claim.status, 303);
  return {
    cookie: claim.headers["set-cookie"]?.[0].split(";")[0] ?? "",
    gateCookie: gateCookie ?? "",
    ticket: location,
  };
}
