import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { authority, mobileProfile } from "../src/certificates.mjs";
import { start } from "../src/server.mjs";
import { write, secret, read } from "../src/state.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const exec = promisify(execFile);
async function runCli(home, ...args) {
  const { stdout } = await exec(
    process.execPath,
    [cli, "--home", home, ...args, "--json"],
    { timeout: 10_000 },
  );
  return JSON.parse(stdout);
}
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
    headers = {},
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
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw: Buffer.concat(chunks),
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
async function fixture(t, daemonOptions = {}) {
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

test("bundled server code can dynamically require a Node builtin from CommonJS", async (t) => {
  const { project, daemon } = await fixture(t, { pollMs: 3_600_000 });
  write(path.join(project, "server", "common.cjs"), `
    module.exports = (name) => require(name).Buffer.from("fleet").toString("hex");
  `);
  write(path.join(project, "server", "index.ts"), `
    import encode from "./common.cjs";
    export default { queries: { encode: (_ctx, input) => encode(input) } };
  `);
  const app = daemon.runtime.find("notes");
  assert.equal(await daemon.runtime.call(app, "queries", "encode", "buffer"), "666c656574");
});

test("public assets and head metadata follow the last successful build", async (t) => {
  const { daemon, ca, project } = await fixture(t, { pollMs: 3_600_000 });
  const app = daemon.runtime.find("notes");
  const manifestFile = path.join(project, "fleet.json");
  write(manifestFile, {
    ...read(manifestFile),
    title: 'Notes <& "private">',
    themeColor: '#123456" data-test="unsafe',
    icon: "/icons/note.svg",
    manifest: "/app.webmanifest",
  });
  const icon = path.join(project, "public", "icons", "note.svg");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  write(icon, svg);
  write(path.join(project, "public", "app.webmanifest"), { name: "Notes" });
  write(path.join(project, "public", "app.js"), "shadow bundle");
  write(path.join(project, "public", "app.css"), "shadow stylesheet");
  write(path.join(project, "public", "__fleet", "hidden.txt"), "shadow endpoint");
  write(path.join(project, ".env.fleet.server"), "PRIVATE=server-secret");
  fs.symlinkSync("../../.env.fleet.server", path.join(project, "public", "icons", "link.txt"));
  fs.symlinkSync("..", path.join(project, "public", "linked-dir"), "dir");
  await daemon.runtime.build(app);

  const auth = await signin(daemon, ca);
  const get = (route, options) => request(daemon, ca, "notes.fleet", route, { ...auth, ...options });
  const page = await get("/watch/123");
  assert.equal(page.status, 200);
  for (const tag of [
    "<title>Notes &lt;&amp; &quot;private&quot;&gt;</title>",
    '<meta name="theme-color" content="#123456&quot; data-test=&quot;unsafe">',
    '<link rel="icon" href="/icons/note.svg">',
    '<link rel="apple-touch-icon" href="/icons/note.svg">',
    '<link rel="manifest" href="/app.webmanifest">',
  ]) assert.ok(page.text.includes(tag), tag);

  const asset = await get("/icons/note.svg");
  assert.equal(asset.status, 200);
  assert.equal(asset.text, svg);
  assert.equal(asset.headers["content-type"], "image/svg+xml");
  assert.equal(asset.headers["x-content-type-options"], "nosniff");
  assert.match(asset.headers["cache-control"], /private, no-cache/);
  assert.equal((await get("/app.webmanifest")).headers["content-type"], "application/manifest+json");
  const head = await get("/icons/note.svg", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], String(Buffer.byteLength(svg)));
  assert.equal(head.text, "");
  const cached = await get("/icons/note.svg", {
    headers: { "If-None-Match": `"previous", W/${asset.headers.etag}` },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, "");
  for (const route of [
    "/icons/link.txt",
    "/linked-dir/.env.fleet.server",
    "/../.env.fleet.server",
    "/icons/%2e%2e/icons/note.svg",
    "/icons%5c..%5c.env.fleet.server",
    "/icons/note.svg/child",
  ]) {
    const missing = await get(route);
    assert.equal(missing.status, 200, route);
    assert.equal(missing.text, page.text, route);
  }
  assert.doesNotMatch((await get("/app.js")).text, /shadow bundle/);
  assert.doesNotMatch((await get("/app.css")).text, /shadow stylesheet/);
  assert.equal((await get("/__fleet/hidden.txt")).status, 404);

  const server = path.join(project, "server", "index.ts");
  const validServer = fs.readFileSync(server);
  write(server, "export default {");
  write(icon, "<svg>updated</svg>");
  await daemon.runtime.build(app);
  assert.ok(app.buildError);
  assert.equal((await get("/icons/note.svg")).text, svg);
  write(server, validServer);
  await daemon.runtime.build(app);
  const updated = await get("/icons/note.svg", {
    headers: { "If-None-Match": asset.headers.etag },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.text, "<svg>updated</svg>");
  assert.notEqual(updated.headers.etag, asset.headers.etag);
});

test("queries read committed data while an async mutation waits, including on rollback", { timeout: 10_000 }, async (t) => {
  const { daemon, project } = await fixture(t, { pollMs: 3_600_000 });
  write(path.join(project, "server", "index.ts"), `
    export default {
      queries: {
        read: ({ db }) => ({ value: db.get("value"), all: db.list() }),
        set: ({ db }) => db.set("value", "illegal"),
        delete: ({ db }) => db.delete("value"),
      },
      mutations: {
        save: ({ db }) => db.set("value", "committed"),
        async slow({ db }, url) {
          db.set("value", "uncommitted");
          db.set("pending", true);
          await fetch(url);
          throw new Error("roll back");
        },
      },
    };
  `);
  const app = daemon.runtime.find("notes");
  const call = (kind, name, input = null) => daemon.runtime.call(app, kind, name, input);
  await call("mutations", "save");
  const { promise: waiting, resolve: arrived } = Promise.withResolvers();
  const remote = http.createServer((_request, response) => arrived(response));
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    remote.closeAllConnections();
    remote.close();
  });
  const mutation = assert.rejects(
    call("mutations", "slow", `http://127.0.0.1:${remote.address().port}`),
    /roll back/,
  );
  const response = await waiting;
  const expected = { value: "committed", all: [{ key: "value", value: "committed" }] };
  try {
    const snapshot = await Promise.race([
      call("queries", "read"),
      delay(2_000, undefined, { ref: false }).then(() => assert.fail("Query waited for the mutation")),
    ]);
    assert.deepEqual(snapshot, expected);
    for (const name of ["set", "delete"])
      await assert.rejects(call("queries", name), /Queries cannot change data/);
  } finally {
    response.end();
    await mutation;
  }
  assert.deepEqual(await call("queries", "read"), expected);
});

test("inspect reports the current build operations before the worker starts", async (t) => {
  const { daemon, home, project } = await fixture(t, { pollMs: 3_600_000 });
  const initial = await runCli(home, "inspect", "notes");
  assert.deepEqual(initial.operations.queries, ["notes"]);
  assert.equal(initial.running, false);

  const source = path.join(project, "server", "index.ts");
  write(source, `
    export default {
      queries: { count() { return 0; }, invalid: true },
      mutations: { reset() {} },
      jobs: { check() {} },
    };
  `);
  const app = daemon.runtime.find("notes");
  await until(() => app.revision !== initial.revision && !app.building);
  const expected = { queries: ["count"], mutations: ["reset"], jobs: ["check"] };
  const updated = await runCli(home, "inspect", "notes");
  assert.equal(updated.running, false);
  assert.deepEqual(updated.operations, expected);
  assert.deepEqual(
    read(path.join(home, "builds", app.id, "current.json")).operations,
    expected,
  );

  // Force the restarted daemon to use the cached build.
  write(source, "export default {");
  await daemon.close();
  const restarted = await start(home, {
    hosts: ["127.0.0.1"],
    httpsPort: 0,
    adminPort: 0,
    noDns: true,
    pollMs: 3_600_000,
  });
  try {
    const cached = await runCli(home, "inspect", "notes");
    assert.equal(cached.revision, updated.revision);
    assert.equal(cached.running, false);
    assert.ok(cached.error);
    assert.deepEqual(cached.operations, expected);
  } finally {
    await restarted.close();
  }
});

test("client error reports require Gate and a matching origin, and fit within log limits", async (t) => {
  const { daemon, ca, home } = await fixture(t);
  const auth = await signin(daemon, ca);
  const report = (data, options) =>
    request(daemon, ca, "notes.fleet", "/__fleet/client-error", {
      method: "POST",
      data,
      ...options,
    });
  assert.equal((await report('{"message":"anonymous"}')).status, 401);
  assert.equal((await report('{"message":"wrong origin"}', {
    ...auth,
    origin: "https://other.fleet",
  })).status, 403);
  assert.equal((await report("{}", auth)).status, 400);
  assert.equal((await report(JSON.stringify({ message: "x".repeat(4096) }), auth)).status, 413);
  const saved = await report(JSON.stringify({ message: "Startup failed\r\nnewline" }), auth);
  assert.equal(saved.status, 204);
  assert.equal(saved.text, "");
  for (let i = 0; i < 7; i++)
    assert.equal((await report('{"message":"repeat"}', auth)).status, 204);
  assert.equal((await report('{"message":"rate limited"}', auth)).status, 429);
  const { lines } = await runCli(home, "logs", "notes");
  const reports = lines.filter((line) => line.includes("Client error: "));
  assert.equal(reports.length, 8);
  assert.match(reports[0], /Client error: Startup failed newline$/);
  assert.doesNotMatch(lines.join("\n"), /anonymous|wrong origin|rate limited/);
  assert.equal(daemon.runtime.find("notes").worker, null);
});

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
  const page = await request(daemon, ca, "notes.fleet", "/", auth);
  const asset = /src="(\/app\.js\?v=[0-9a-f]+)"/.exec(page.text)[1];
  const versioned = await request(daemon, ca, "notes.fleet", asset, {
    ...auth,
    headers: { "Accept-Encoding": "gzip, br" },
  });
  assert.equal(versioned.headers["content-encoding"], "br");
  assert.match(versioned.headers["cache-control"], /immutable/);
  assert.ok(versioned.raw.length < bundle.raw.length / 2);
  assert.equal(
    zlib.brotliDecompressSync(versioned.raw).toString(),
    bundle.text,
  );
  const gzip = await request(daemon, ca, "notes.fleet", asset, {
    ...auth,
    headers: { "Accept-Encoding": "gzip, br;q=0" },
  });
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.match(bundle.headers["cache-control"], /no-cache/);
  const unchanged = await request(daemon, ca, "notes.fleet", "/app.js", {
    ...auth,
    headers: { "If-None-Match": bundle.headers.etag },
  });
  assert.equal(unchanged.status, 304);
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
  assert.equal(response.status, 200, response.text);
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

test("waking an idle app waits for its previous worker to exit", async (t) => {
  const { daemon } = await fixture(t, { pollMs: 3_600_000 });
  const { runtime } = daemon;
  const app = runtime.find("notes");
  const saved = await runtime.call(app, "mutations", "addNote", {
    text: "Keep this on wake",
  });
  const previous = app.worker;
  const terminate = previous.terminate.bind(previous);
  const { promise: canExit, resolve: release } = Promise.withResolvers();
  const stopping = canExit.then(() => terminate());
  t.mock.method(previous, "terminate", () => stopping);
  let query;
  let notes;
  try {
    app.lastUsed = 0;
    await runtime.tick();
    assert.equal(app.worker, null);
    query = runtime.call(app, "queries", "notes", null);
    await new Promise(setImmediate);
    assert.ok(!app.worker, "A replacement started before the old worker exited.");
  } finally {
    release();
    await stopping;
    notes = await query;
  }
  assert.deepEqual(notes, [saved]);
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
  // Close before the fixture removes its directory: Windows cannot delete an
  // open SQLite file.
  try {
    const again = await signin(restarted, ca);
    const persisted = await request(
      restarted,
      ca,
      "notes.fleet",
      "/__fleet/api/queries/notes",
      { ...again, method: "POST", data: "null" },
    );
    assert.equal(JSON.parse(persisted.text).value[0].text, "Survives edits");
  } finally {
    await restarted.close();
  }
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

test("a shorter job interval moves the next run forward but keeps retry due dates", async (t) => {
  const { daemon, project, home } = await fixture(t, { pollMs: 3_600_000 });
  const app = daemon.runtime.find("notes");
  const manifest = path.join(project, "fleet.json");
  const jobsFile = path.join(home, "jobs.json");
  const nextKey = `${app.id}/dailyCheck`;
  const retryKey = `${app.id}/retryCheck`;
  const setInterval = (everySeconds) => write(manifest, {
    ...read(manifest),
    jobs: ["dailyCheck", "retryCheck"].map((name) => ({ name, everySeconds })),
  });
  setInterval(300);
  await daemon.runtime.build(app);
  await daemon.runtime.tick();
  const before = read(jobsFile);
  assert.ok(before[nextKey].due > Date.now() + 200_000);
  before[nextKey].lastRun = "2026-01-01T00:00:00.000Z";
  before[retryKey].runId = "interrupted-run";
  write(jobsFile, before);

  setInterval(5);
  await daemon.runtime.build(app);
  const started = Date.now();
  await daemon.runtime.tick();
  const after = read(jobsFile);
  assert.ok(after[nextKey].due >= started + 5000);
  assert.ok(after[nextKey].due <= Date.now() + 5000);
  assert.equal(after[nextKey].lastRun, before[nextKey].lastRun);
  assert.deepEqual(after[retryKey], before[retryKey]);
  assert.equal(app.worker, null);
});

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
  const manifest = path.join(project, "fleet.json");
  write(manifest, { ...read(manifest), title: "Remote notes", icon: "/icon.png" });
  // Use an asset too large for the peer JSON response limit.
  const icon = Buffer.alloc(6_100_000, 42);
  write(path.join(project, "public", "icon.png"), icon);
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
  const asset = await request(gateway, ca, "remote-notes.fleet", "/icon.png", auth);
  assert.equal(asset.status, 200);
  assert.deepEqual(asset.raw, icon);
  assert.equal(asset.headers["content-type"], "image/png");
  assert.equal(asset.headers["x-content-type-options"], "nosniff");
  const head = await request(gateway, ca, "remote-notes.fleet", "/icon.png", {
    ...auth,
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], String(icon.length));
  assert.equal(head.text, "");
  const cached = await request(gateway, ca, "remote-notes.fleet", "/icon.png", {
    ...auth,
    headers: { "If-None-Match": asset.headers.etag },
  });
  assert.equal(cached.status, 304);
  const page = await request(gateway, ca, "remote-notes.fleet", "/watch/123", auth);
  assert.match(page.text, /<title>Remote notes<\/title>/);
  assert.match(page.text, /<link rel="icon" href="\/icon.png">/);
  const inspect = await runCli(home, "inspect", "remote-notes");
  assert.deepEqual(inspect.operations.queries, ["notes"]);
  const report = await request(gateway, ca, "remote-notes.fleet", "/__fleet/client-error", {
    ...auth,
    method: "POST",
    data: '{"message":"Remote crash"}',
  });
  assert.equal(report.status, 204);
  assert.ok((await runCli(nodeHome, "logs", "remote-notes")).lines.some(
    (line) => line.endsWith("Client error: Remote crash"),
  ));
  const nodeApp = node.runtime.find("remote-notes");
  assert.ok(
    fs.existsSync(path.join(nodeHome, "data", nodeApp.id, "app.sqlite")),
  );
  assert.equal(fs.existsSync(path.join(home, "data", nodeApp.id)), false);
});

test("the phone setup delivers only the profile, signs in at gate.fleet/phone, and turns off setup automatically", async (t) => {
  let phoneOffCalls = 0;
  const { daemon, ca } = await fixture(t, {
    disablePhoneRoute: async () => {
      phoneOffCalls++;
      return { removed: true };
    },
  });
  const setup = await fetch(
    `http://127.0.0.1:${daemon.adminPort}${daemon.setupPath}`,
  );
  assert.equal(setup.status, 200);
  const html = await setup.text();
  assert.match(html, /VPN &amp; Device Management/);
  assert.match(html, /Certificate Trust Settings/);
  const link = /href="([^"]+\/phone\?ticket=[^"]+)"/.exec(html)[1];
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
  assert.equal(phoneOffCalls, 0);
  const url = new URL(link);
  const claim = await request(
    daemon,
    ca,
    "gate.fleet",
    url.pathname + url.search,
  );
  assert.equal(claim.status, 303);
  assert.equal(claim.headers.location, "/phone");
  assert.equal(phoneOffCalls, 1);
  assert.equal(
    (await fetch(`http://127.0.0.1:${daemon.adminPort}${daemon.setupPath}`))
      .status,
    403,
  );
  const gateCookie = claim.headers["set-cookie"][0].split(";")[0];
  const phonePage = await request(daemon, ca, "gate.fleet", "/phone", {
    cookie: gateCookie,
  });
  assert.equal(phonePage.status, 200);
  assert.match(phonePage.text, /Phone connected/);
  assert.match(phonePage.text, /turned off automatically/);
  assert.match(phonePage.text, /notes/);
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
  assert.equal(phoneOffCalls, 1);
});
