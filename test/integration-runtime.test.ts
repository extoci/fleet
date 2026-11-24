import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "bun:test";
import { authority, mobileProfile } from "../src/certificates.ts";
import { exportData, restoreData } from "../src/data.ts";
import { type PeerRecord, Peers, peerRequest } from "../src/peers.ts";
import { start } from "../src/server.ts";
import { type FleetConfig, read, secret, write } from "../src/state.ts";
import {
  cli,
  cleanups,
  fixture,
  request,
  runCli,
  signin,
  until,
  wait,
} from "./integration-helpers.ts";

test("live builds retain the previous app on build failure and keep data across daemon restart", async () => {
  const { daemon, ca, home, project } = await fixture();
  const auth = await signin(daemon, ca);
  const response = await request(daemon, ca, "notes.fleet", "/__fleet/api/mutations/addNote", {
    ...auth,
    method: "POST",
    data: JSON.stringify({ text: "Survives edits" }),
  });
  assert.equal(response.status, 200);
  const app = daemon.runtime.find("notes")!;
  const before = app.revision;
  const source = path.join(project, "server", "index.ts");
  const original = fs.readFileSync(source, "utf8");
  write(source, "export default { BROKEN SYNTAX");
  await until(() => Boolean(app.buildError));
  assert.equal(app.revision, before);
  const query = await request(daemon, ca, "notes.fleet", "/__fleet/api/queries/notes", {
    ...auth,
    method: "POST",
    data: "null",
  });
  assert.equal(
    (JSON.parse(query.text) as { value: Array<{ text: string }> }).value[0].text,
    "Survives edits",
  );
  write(
    source,
    original.replace(
      "return ctx.db.get('notes') ?? [];",
      "return [...(ctx.db.get('notes') ?? []), { text: \"Live update\" }];",
    ),
  );
  await until(() => app.revision !== before && !app.buildError);
  const updated = await request(daemon, ca, "notes.fleet", "/__fleet/api/queries/notes", {
    ...auth,
    method: "POST",
    data: "null",
  });
  assert.equal(
    (JSON.parse(updated.text) as { value: Array<{ text: string }> }).value[1].text,
    "Live update",
  );
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
    const persisted = await request(restarted, ca, "notes.fleet", "/__fleet/api/queries/notes", {
      ...again,
      method: "POST",
      data: "null",
    });
    assert.equal(
      (JSON.parse(persisted.text) as { value: Array<{ text: string }> }).value[0].text,
      "Survives edits",
    );
  } finally {
    await restarted.close();
  }
});

function readJob(home: string, appId: string) {
  const jobs = JSON.parse(fs.readFileSync(path.join(home, "jobs.json"), "utf8")) as Record<
    string,
    { lastRun?: string; due: number; runId?: string }
  >;
  return jobs[`${appId}/dailyCheck`];
}

test("scheduled work runs without a browser and an interrupted occurrence reuses its run ID", async () => {
  const { daemon, project, home } = await fixture();
  const app = daemon.runtime.find("notes")!;
  const metadata = JSON.parse(fs.readFileSync(path.join(project, "fleet.json"), "utf8")) as {
    jobs: Array<{ name: string; everySeconds: number }>;
  };
  metadata.jobs = [{ name: "dailyCheck", everySeconds: 5 }];
  write(path.join(project, "fleet.json"), metadata);
  write(path.join(home, "jobs.json"), {
    [`${app.id}/dailyCheck`]: {
      due: Date.now() - 1,
      runId: "interrupted-occurrence",
    },
  });
  await until(() => readJob(home, app.id)?.lastRun);
  const result = await daemon.runtime.call(app, "queries", "notes", null);
  assert.deepEqual(result, []);
  const log = fs.readFileSync(path.join(home, "logs", `${app.id}.log`), "utf8");
  assert.match(log, /interrupted-occurrence/);
});

test("a shorter job interval moves the next run forward but keeps retry due dates", async () => {
  const { daemon, project, home } = await fixture({ pollMs: 3_600_000 });
  const app = daemon.runtime.find("notes")!;
  const manifestPath = path.join(project, "fleet.json");
  const jobsFile = path.join(home, "jobs.json");
  const nextKey = `${app.id}/dailyCheck`;
  const retryKey = `${app.id}/retryCheck`;
  const setJobInterval = (everySeconds: number) =>
    write(manifestPath, {
      ...read<Record<string, unknown>>(manifestPath, {}),
      jobs: ["dailyCheck", "retryCheck"].map((name) => ({ name, everySeconds })),
    });
  setJobInterval(300);
  await daemon.runtime.build(app);
  await daemon.runtime.tick();
  const before = read<Record<string, { due: number; lastRun?: string; runId?: string }>>(
    jobsFile,
    {},
  );
  assert.ok(before[nextKey].due > Date.now() + 200_000);
  before[nextKey].lastRun = "2026-01-01T00:00:00.000Z";
  before[retryKey].runId = "interrupted-run";
  write(jobsFile, before);

  setJobInterval(5);
  await daemon.runtime.build(app);
  const started = Date.now();
  await daemon.runtime.tick();
  const after = read<Record<string, { due: number; lastRun?: string; runId?: string }>>(
    jobsFile,
    {},
  );
  assert.ok(after[nextKey].due >= started + 5000);
  assert.ok(after[nextKey].due <= Date.now() + 5000);
  assert.equal(after[nextKey].lastRun, before[nextKey].lastRun);
  assert.deepEqual(after[retryKey], before[retryKey]);
  assert.equal(app.worker, null);
});

test("data snapshots are consistent and restoring requires the daemon to be stopped", async () => {
  const { daemon, home } = await fixture();
  const app = daemon.runtime.find("notes")!;
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
  const db = new DatabaseSync(path.join(home, "data", app.id, "app.sqlite"));
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key='notes'").get() as { value: string };
    const notes = JSON.parse(row.value) as Array<{ text: string }>;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, "Keep this");
  } finally {
    db.close();
  }
});

test("root persists and the Apple profile contains only a public certificate", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-cert-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const rootPem = authority(home).pem;
  assert.equal(authority(home).pem, rootPem);
  const profile = mobileProfile(home);
  assert.match(profile, /com.apple.security.root/);
  assert.doesNotMatch(profile, /PRIVATE KEY|com.apple.vpn|com.apple.mdm/);
  const data = /<data>([^<]+)<\/data>/.exec(profile)![1];
  assert.equal(
    new X509Certificate(Buffer.from(data, "base64")).toString(),
    new X509Certificate(rootPem).toString(),
  );
});

test("one Gate and gateway serve apps from another computer with a pinned root and one-use invitation", async () => {
  const { home, daemon, ca } = await fixture();
  const nodeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-node-"));
  const project = path.join(nodeHome, "remote-notes");
  execFileSync(process.execPath, [cli, "init", project, "--json"], {
    env: { ...process.env, FLEET_V2_HOME: nodeHome },
    stdio: "pipe",
  });
  const manifestPath = path.join(project, "fleet.json");
  write(manifestPath, {
    ...read<Record<string, unknown>>(manifestPath, {}),
    title: "Remote notes",
    icon: "/icon.png",
  });
  // Use an asset too large for the peer JSON response limit.
  const icon = Buffer.alloc(6_100_000, 42);
  write(path.join(project, "public", "icon.png"), icon);
  const config = read<FleetConfig>(path.join(home, "config.json"), {} as FleetConfig);
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
  const nodeRef: { current?: Awaited<ReturnType<typeof start>> } = {};
  cleanups.push(async () => {
    await nodeRef.current?.close();
    await gateway.close();
    await wait(100);
    fs.rmSync(nodeHome, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  const invite = new Peers(home, gateway.runtime, {
    allowLoopback: true,
  }).invite({ ...config, addresses: ["127.0.0.1"], httpsPort: gateway.httpsPort }, ca);
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
  const node = await start(nodeHome, { nodePort: 0, adminPort: 0 });
  nodeRef.current = node;
  const registeredPeers = read<PeerRecord[]>(path.join(home, "peers.json"), []);
  assert.equal(registeredPeers.length, 1);
  assert.equal(
    Object.keys(read<Record<string, unknown>>(path.join(home, "node-invites.json"), {})).length,
    0,
  );
  const aliasTarget = "http://service.example.test/";
  await assert.rejects(
    runCli(home, "alias", "remote-notes", aliasTarget),
    /belongs to a Fleet app/,
  );
  await runCli(home, "alias", "media", aliasTarget);
  const [registered] = registeredPeers;
  await assert.rejects(
    peerRequest(
      {
        address: "127.0.0.1",
        port: gateway.httpsPort,
        ca,
        token: registered.token,
        route: "/__fleet/peers/register",
      },
      "register",
      { ...registered, apps: [...registered.apps, { id: randomUUID(), name: "media" }] },
    ),
    /The name media is already in use in Fleet/,
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
  const query = await request(gateway, ca, "remote-notes.fleet", "/__fleet/api/queries/notes", {
    ...auth,
    method: "POST",
    data: "null",
  });
  assert.equal(
    (JSON.parse(query.text) as { value: Array<{ text: string }> }).value[0].text,
    "Stored on the checkout computer",
  );
  const bundle = await request(gateway, ca, "remote-notes.fleet", "/app.js", auth);
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
    headers: { "If-None-Match": String(asset.headers.etag) },
  });
  assert.equal(cached.status, 304);
  const page = await request(gateway, ca, "remote-notes.fleet", "/watch/123", auth);
  assert.match(page.text, /<title>Remote notes<\/title>/);
  assert.match(page.text, /<link rel="icon" href="\/icon.png">/);
  const inspect = await runCli<{ operations: Record<string, string[]> }>(
    home,
    "inspect",
    "remote-notes",
  );
  assert.deepEqual(inspect.operations.queries, ["notes"]);
  const report = await request(gateway, ca, "remote-notes.fleet", "/__fleet/client-error", {
    ...auth,
    method: "POST",
    data: '{"message":"Remote crash"}',
  });
  assert.equal(report.status, 204);
  assert.ok(
    (await runCli<{ lines: string[] }>(nodeHome, "logs", "remote-notes")).lines.some((line) =>
      line.endsWith("Client error: Remote crash"),
    ),
  );
  const nodeApp = node.runtime.find("remote-notes")!;
  assert.ok(fs.existsSync(path.join(nodeHome, "data", nodeApp.id, "app.sqlite")));
  assert.equal(fs.existsSync(path.join(home, "data", nodeApp.id)), false);
});

test("the phone setup delivers only the profile, signs in at gate.fleet/phone, and turns off setup automatically", async () => {
  let phoneOffCalls = 0;
  const { daemon, ca } = await fixture({
    disablePhoneRoute: async () => {
      phoneOffCalls++;
      return { removed: true };
    },
  });
  const setup = await fetch(`http://127.0.0.1:${daemon.adminPort}${daemon.setupPath}`);
  assert.equal(setup.status, 200);
  const html = await setup.text();
  assert.match(html, /VPN &amp; Device Management/);
  assert.match(html, /Certificate Trust Settings/);
  const link = /href="([^"]+\/phone\?ticket=[^"]+)"/.exec(html)![1];
  const profile = await fetch(
    `http://127.0.0.1:${daemon.adminPort}${daemon.setupPath}/fleet.mobileconfig`,
  );
  assert.equal(profile.status, 200);
  assert.match(String(profile.headers.get("content-type")), /application\/x-apple-aspen-config/);
  assert.doesNotMatch(await profile.text(), /PRIVATE KEY/);
  const setupFont = await fetch(
    `http://127.0.0.1:${daemon.adminPort}${daemon.setupPath}/geist-pixel-square.woff2`,
  );
  assert.equal(setupFont.status, 200);
  assert.equal(setupFont.headers.get("content-type"), "font/woff2");
  const gateFont = await request(
    daemon,
    ca,
    "gate.fleet",
    "/__fleet/assets/geist-pixel-square.woff2",
  );
  assert.equal(gateFont.status, 200);
  assert.equal(gateFont.headers["content-type"], "font/woff2");
  assert.match(String(gateFont.headers["cache-control"]), /immutable/);
  assert.equal(
    (await fetch(`http://127.0.0.1:${daemon.adminPort}/setup/wrong/fleet.mobileconfig`)).status,
    403,
  );
  assert.equal(phoneOffCalls, 0);
  const url = new URL(link);
  const claim = await request(daemon, ca, "gate.fleet", url.pathname + url.search);
  assert.equal(claim.status, 303);
  assert.equal(claim.headers.location, "/phone");
  assert.equal(phoneOffCalls, 1);
  assert.equal(
    (await fetch(`http://127.0.0.1:${daemon.adminPort}${daemon.setupPath}`)).status,
    403,
  );
  const gateCookie = claim.headers["set-cookie"]![0].split(";")[0];
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
  const replay = await request(daemon, ca, "gate.fleet", url.pathname + url.search);
  assert.equal(replay.headers["set-cookie"], undefined);
  assert.equal(phoneOffCalls, 1);
});
