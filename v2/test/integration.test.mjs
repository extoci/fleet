import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { authority, mobileProfile } from "../src/certificates.mjs";
import { start } from "../src/server.mjs";
import { write, secret, read } from "../src/state.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(40);
  }
  throw new Error("Condition did not become true.");
}
function request(
  daemon,
  ca,
  host,
  route = "/",
  {
    method = "GET",
    data,
    cookie,
    origin = `https://${host}:${daemon.httpsPort}`,
  } = {},
) {
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
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.setTimeout(10000, () =>
      req.destroy(new Error("Test request timed out.")),
    );
    req.on("error", reject);
    req.end(data);
  });
}
async function fixture(t) {
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
  });
  t.after(async () => {
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
async function signin(daemon, ca, name = "notes", gateCookie) {
  if (!gateCookie) {
    const response = await request(
      daemon,
      ca,
      "gate.fleet",
      `/__fleet/login?app=${name}`,
      { method: "POST", data: `code=${daemon.gate.pair()}` },
    );
    assert.equal(response.status, 303);
    gateCookie = response.headers["set-cookie"][0].split(";")[0];
  }
  const login = await request(
    daemon,
    ca,
    "gate.fleet",
    `/__fleet/login?app=${name}`,
    { cookie: gateCookie },
  );
  assert.equal(login.status, 303);
  const claim = await request(
    daemon,
    ca,
    `${name}.fleet`,
    new URL(login.headers.location).pathname +
      new URL(login.headers.location).search,
  );
  assert.equal(claim.status, 303);
  return {
    cookie: claim.headers["set-cookie"][0].split(";")[0],
    gateCookie,
    ticket: login.headers.location,
  };
}

test("Gate, cached frontend, persistent data, idle unload, CSRF, and revocation work together", async (t) => {
  const { daemon, ca, home } = await fixture(t);
  assert.equal((await request(daemon, ca, "notes.fleet")).status, 303);
  const auth = await signin(daemon, ca);
  assert.equal(
    (await request(daemon, ca, "notes.fleet", "/", auth)).status,
    200,
  );
  const bundle = await request(daemon, ca, "notes.fleet", "/app.js", auth);
  assert.equal(bundle.status, 200);
  assert.match(bundle.text, /function/);
  assert.ok(bundle.text.length > 1000);
  const post = (op, input, origin) =>
    request(daemon, ca, "notes.fleet", `/__fleet/api/${op}`, {
      ...auth,
      origin,
      method: "POST",
      data: JSON.stringify(input),
    });
  assert.equal(
    (await post("mutations/addNote", { text: "Persistent personal data" }))
      .status,
    200,
  );
  assert.equal(
    (
      await post(
        "mutations/addNote",
        { text: "Bad origin" },
        "https://other.fleet",
      )
    ).status,
    403,
  );
  const app = daemon.runtime.find("notes");
  await until(() => !app.worker);
  assert.ok(fs.existsSync(path.join(home, "data", app.id, "app.sqlite")));
  const response = await post("queries/notes", null);
  assert.equal(
    JSON.parse(response.text).value[0].text,
    "Persistent personal data",
  );
  assert.equal((await post("mutations/toString", null)).status, 500);
  const replay = new URL(auth.ticket);
  assert.equal(
    (await request(daemon, ca, "notes.fleet", replay.pathname + replay.search))
      .status,
    303,
  );
  daemon.gate.reset();
  assert.equal((await post("queries/notes", null)).status, 401);
  await assert.rejects(
    request(daemon, ca, "unknown.fleet"),
    /TLS|socket|alert|ECONNRESET|disconnected/i,
  );
});

test("live builds retain the previous app on build failure and keep data across daemon restart", async (t) => {
  const { daemon, ca, home, project } = await fixture(t);
  const auth = await signin(daemon, ca);
  const response = await request(
    daemon,
    ca,
    "notes.fleet",
    "/__fleet/api/mutations/addNote",
    {
      ...auth,
      method: "POST",
      data: JSON.stringify({ text: "Survives edits" }),
    },
  );
  assert.equal(response.status, 200);
  const app = daemon.runtime.find("notes");
  const before = app.revision;
  const source = path.join(project, "server", "index.ts");
  const original = fs.readFileSync(source, "utf8");
  write(source, "export default { BROKEN SYNTAX");
  await until(() => Boolean(app.buildError));
  assert.equal(app.revision, before);
  const query = await request(
    daemon,
    ca,
    "notes.fleet",
    "/__fleet/api/queries/notes",
    { ...auth, method: "POST", data: "null" },
  );
  assert.equal(JSON.parse(query.text).value[0].text, "Survives edits");
  write(
    source,
    original.replace(
      "return ctx.db.get('notes') ?? [];",
      "return [...(ctx.db.get('notes') ?? []), { text: \"Live update\" }];",
    ),
  );
  await until(() => app.revision !== before && !app.buildError);
  const updated = await request(
    daemon,
    ca,
    "notes.fleet",
    "/__fleet/api/queries/notes",
    { ...auth, method: "POST", data: "null" },
  );
  assert.equal(JSON.parse(updated.text).value[1].text, "Live update");
  await daemon.close();
  const restarted = await start(home, {
    hosts: ["127.0.0.1"],
    httpsPort: 0,
    adminPort: 0,
    noDns: true,
  });
  t.after(() => restarted.close());
  const again = await signin(restarted, ca);
  const persisted = await request(
    restarted,
    ca,
    "notes.fleet",
    "/__fleet/api/queries/notes",
    { ...again, method: "POST", data: "null" },
  );
  assert.equal(JSON.parse(persisted.text).value[0].text, "Survives edits");
});

test("scheduled work runs without a browser and an interrupted occurrence reuses its run ID", async (t) => {
  const { daemon, project, home } = await fixture(t);
  const app = daemon.runtime.find("notes");
  const metadata = JSON.parse(
    fs.readFileSync(path.join(project, "fleet.json"), "utf8"),
  );
  metadata.jobs = [{ name: "dailyCheck", everySeconds: 5 }];
  write(path.join(project, "fleet.json"), metadata);
  write(path.join(home, "jobs.json"), {
    [`${app.id}/dailyCheck`]: {
      due: Date.now() - 1,
      runId: "interrupted-occurrence",
    },
  });
  await until(() => readJob(home, app)?.lastRun);
  const result = await daemon.runtime.call(app, "queries", "notes", null);
  assert.deepEqual(result, []);
  const log = fs.readFileSync(path.join(home, "logs", `${app.id}.log`), "utf8");
  assert.match(log, /interrupted-occurrence/);
});
function readJob(home, app) {
  return JSON.parse(fs.readFileSync(path.join(home, "jobs.json"), "utf8"))[
    `${app.id}/dailyCheck`
  ];
}

test("data snapshots are consistent and restoring requires the daemon to be stopped", async (t) => {
  const { daemon, home } = await fixture(t);
  const { exportData, restoreData } = await import("../src/data.mjs");
  const app = daemon.runtime.find("notes");
  await daemon.runtime.call(app, "mutations", "addNote", { text: "Keep this" });
  const file = path.join(home, "notes-backup.sqlite");
  await exportData(home, "notes", file);
  await daemon.runtime.call(app, "mutations", "addNote", {
    text: "Added later",
  });
  await assert.rejects(restoreData(home, "notes", file), /Stop Fleet/);
  await daemon.close();
  const previous = await restoreData(home, "notes", file);
  assert.ok(fs.existsSync(previous));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(home, "data", app.id, "app.sqlite"));
  try {
    const notes = JSON.parse(
      db.prepare("SELECT value FROM kv WHERE key='notes'").get().value,
    );
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, "Keep this");
  } finally {
    db.close();
  }
});

test("root persists and the Apple profile contains only a public certificate", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-cert-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = authority(home).pem;
  assert.equal(authority(home).pem, root);
  const profile = mobileProfile(home);
  assert.match(profile, /com.apple.security.root/);
  assert.doesNotMatch(profile, /PRIVATE KEY|com.apple.vpn|com.apple.mdm/);
  const data = /<data>([^<]+)<\/data>/.exec(profile)[1];
  const { X509Certificate } = await import("node:crypto");
  assert.equal(
    new X509Certificate(Buffer.from(data, "base64")).toString(),
    new X509Certificate(root).toString(),
  );
});

test("one Gate and gateway serve apps from another computer with a pinned root and one-use invitation", async (t) => {
  const { home, daemon, ca } = await fixture(t);
  const nodeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-node-"));
  const project = path.join(nodeHome, "remote-notes");
  execFileSync(process.execPath, [cli, "init", project, "--json"], {
    env: { ...process.env, FLEET_V2_HOME: nodeHome },
    stdio: "pipe",
  });
  const config = read(path.join(home, "config.json"));
  // The production enrollment validates Tailscale addresses. The test broker
  // explicitly allows loopback so this exercises actual TLS on random ports.
  await daemon.close();
  const gateway = await start(home, {
    hosts: ["127.0.0.1"],
    httpsPort: 0,
    adminPort: 0,
    noDns: true,
    allowLoopbackPeers: true,
  });
  let node;
  t.after(async () => {
    await node?.close();
    await gateway.close();
    await wait(100);
    fs.rmSync(nodeHome, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const { Peers } = await import("../src/peers.mjs");
  const invite = new Peers(home, gateway.runtime, {
    allowLoopback: true,
  }).invite(
    { ...config, addresses: ["127.0.0.1"], httpsPort: gateway.httpsPort },
    ca,
  );
  write(path.join(nodeHome, "config.json"), {
    version: 2,
    mode: "node",
    nodeId: randomUUID(),
    nodeToken: secret(),
    addresses: ["127.0.0.1"],
    httpsPort: 443,
    adminPort: 0,
    gateway: {
      address: "127.0.0.1",
      port: gateway.httpsPort,
      ca,
      joinToken: invite.token,
    },
  });
  node = await start(nodeHome, { nodePort: 0, adminPort: 0 });
  assert.equal(read(path.join(home, "peers.json"), []).length, 1);
  assert.equal(
    Object.keys(read(path.join(home, "node-invites.json"), {})).length,
    0,
  );
  const auth = await signin(gateway, ca, "remote-notes");
  const response = await request(
    gateway,
    ca,
    "remote-notes.fleet",
    "/__fleet/api/mutations/addNote",
    {
      ...auth,
      method: "POST",
      data: JSON.stringify({ text: "Stored on the checkout computer" }),
    },
  );
  assert.equal(response.status, 200, response.text);
  const query = await request(
    gateway,
    ca,
    "remote-notes.fleet",
    "/__fleet/api/queries/notes",
    { ...auth, method: "POST", data: "null" },
  );
  assert.equal(
    JSON.parse(query.text).value[0].text,
    "Stored on the checkout computer",
  );
  const bundle = await request(
    gateway,
    ca,
    "remote-notes.fleet",
    "/app.js",
    auth,
  );
  assert.equal(bundle.status, 200);
  assert.ok(bundle.text.length > 1000);
  const nodeApp = node.runtime.find("remote-notes");
  assert.ok(
    fs.existsSync(path.join(nodeHome, "data", nodeApp.id, "app.sqlite")),
  );
  assert.equal(fs.existsSync(path.join(home, "data", nodeApp.id)), false);
});

test("the phone setup delivers only the profile and signs the browser into Gate after trust", async (t) => {
  const { daemon, ca } = await fixture(t);
  const setup = await fetch(
    `http://127.0.0.1:${daemon.adminPort}${daemon.setupPath}`,
  );
  assert.equal(setup.status, 200);
  const html = await setup.text();
  assert.match(html, /Certificate Trust Settings/);
  const link = /href="([^"]+\/__fleet\/claim\?ticket=[^"]+)"/.exec(html)[1];
  const profile = await fetch(
    `http://127.0.0.1:${daemon.adminPort}${daemon.setupPath}/fleet.mobileconfig`,
  );
  assert.equal(profile.status, 200);
  assert.match(
    profile.headers.get("content-type"),
    /application\/x-apple-aspen-config/,
  );
  assert.doesNotMatch(await profile.text(), /PRIVATE KEY/);
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:${daemon.adminPort}/setup/wrong/fleet.mobileconfig`,
      )
    ).status,
    403,
  );
  const url = new URL(link);
  const claim = await request(
    daemon,
    ca,
    "gate.fleet",
    url.pathname + url.search,
  );
  assert.equal(claim.status, 303);
  const gateCookie = claim.headers["set-cookie"][0].split(";")[0];
  const index = await request(daemon, ca, "gate.fleet", "/", {
    cookie: gateCookie,
  });
  assert.equal(index.status, 200);
  assert.match(index.text, /notes/);
  const replay = await request(
    daemon,
    ca,
    "gate.fleet",
    url.pathname + url.search,
  );
  assert.equal(replay.headers["set-cookie"], undefined);
});
