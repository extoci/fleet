import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Resolver } from "node:dns/promises";
import fs from "node:fs";
import http, { type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import zlib from "node:zlib";
import { spyOn, test } from "bun:test";
import type { OperationKind } from "../src/app-definition.ts";
import { start } from "../src/server.ts";
import { read, write } from "../src/state.ts";
import { cleanups, fixture, request, runCli, signin, until } from "./integration-helpers.ts";

test("gateway aliases resolve over DNS and redirect through Gate without a daemon restart", async () => {
  const { home, daemon, ca } = await fixture({ noDns: false });
  assert.ok(daemon.dnsPort);
  const resolve4 = (host: string) => {
    const resolver = new Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers([`127.0.0.1:${daemon.dnsPort}`]);
    return resolver.resolve4(host);
  };
  const host = "media.fleet";
  const target = "https://service.example.test:7337/dashboard?view=grid#recent";
  assert.deepEqual(await runCli(home, "alias", "media", target), {
    name: "media",
    target,
    url: `https://${host}`,
  });
  assert.deepEqual(await resolve4(host), ["127.0.0.1"]);

  const signedOut = await request(daemon, ca, host);
  assert.equal(signedOut.status, 303);
  assert.equal(
    signedOut.headers.location,
    `https://gate.fleet:${daemon.httpsPort}/__fleet/login?app=media`,
  );
  assert.equal(signedOut.text, "");

  const { url } = await runCli<{ url: string }>(home, "open", "media");
  const open = new URL(url);
  assert.equal(open.origin, `https://gate.fleet:${daemon.httpsPort}`);
  const claim = await request(daemon, ca, open.hostname, open.pathname + open.search);
  assert.equal(claim.status, 303);
  assert.equal(claim.headers.location, "/__fleet/login?app=media");
  assert.equal(claim.text, "");
  const gateCookie = claim.headers["set-cookie"]?.[0].split(";")[0];
  assert.ok(gateCookie);
  const auth = await signin(daemon, ca, "media", gateCookie);
  const index = await request(daemon, ca, "gate.fleet", "/", { cookie: auth.gateCookie });
  assert.equal(index.status, 200);
  assert.ok(index.text.includes(`href="https://${host}:${daemon.httpsPort}"`));
  assert.ok(index.text.includes("Redirect</span>"));

  const redirect = await request(daemon, ca, host, "/extra?app=unknown", auth);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, target);
  assert.equal(redirect.headers["cache-control"], "no-store");
  assert.equal(redirect.text, "");
  const post = await request(daemon, ca, host, "/", { ...auth, method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal(post.text, "Use GET or HEAD.");

  await assert.rejects(runCli(home, "alias", "notes", target), /belongs to a Fleet app/);
  const conflict = path.join(home, "conflict");
  write(path.join(conflict, "fleet.json"), { version: 2, id: randomUUID(), name: "media" });
  await assert.rejects(runCli(home, "register", conflict), /is a Fleet alias/);
  await assert.rejects(
    runCli(home, "alias", "media", "file:///tmp/service"),
    /Use a full HTTP or HTTPS URL/,
  );
  const updatedTarget = target.replace(":7337/", ":7338/");
  await runCli(home, "alias", "media", updatedTarget);
  const updated = await request(daemon, ca, host, "/", { ...auth, method: "HEAD" });
  assert.equal(updated.status, 302);
  assert.equal(updated.headers.location, updatedTarget);
  assert.equal(updated.text, "");

  await runCli(home, "unregister", "media");
  await assert.rejects(resolve4(host), { code: "ENOTFOUND" });
  await runCli(home, "unregister", "notes");
  await assert.rejects(runCli(home, "alias", "notes", target), /belongs to a Fleet app/);
});

test("bundled server code can dynamically require a Node builtin from CommonJS", async () => {
  const { project, daemon } = await fixture({ pollMs: 3_600_000 });
  write(
    path.join(project, "server", "common.cjs"),
    `
    module.exports = (name) => require(name).Buffer.from("fleet").toString("hex");
  `,
  );
  write(
    path.join(project, "server", "index.ts"),
    `
    import encode from "./common.cjs";
    export default { queries: { encode: (_ctx, input) => encode(input) } };
  `,
  );
  const app = daemon.runtime.find("notes")!;
  assert.equal(await daemon.runtime.call(app, "queries", "encode", "buffer"), "666c656574");
});

test("public assets and head metadata follow the last successful build", async () => {
  const { daemon, ca, project } = await fixture({ pollMs: 3_600_000 });
  const app = daemon.runtime.find("notes")!;
  const manifestFile = path.join(project, "fleet.json");
  write(manifestFile, {
    ...read<Record<string, unknown>>(manifestFile, {}),
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
  const get = (route: string, options?: Parameters<typeof request>[4]) =>
    request(daemon, ca, "notes.fleet", route, { ...auth, ...options });
  const page = await get("/watch/123");
  assert.equal(page.status, 200);
  for (const tag of [
    "<title>Notes &lt;&amp; &quot;private&quot;&gt;</title>",
    '<meta name="theme-color" content="#123456&quot; data-test=&quot;unsafe">',
    '<link rel="icon" href="/icons/note.svg">',
    '<link rel="apple-touch-icon" href="/icons/note.svg">',
    '<link rel="manifest" href="/app.webmanifest">',
  ]) {
    assert.ok(page.text.includes(tag), tag);
  }

  const asset = await get("/icons/note.svg");
  assert.equal(asset.status, 200);
  assert.equal(asset.text, svg);
  assert.equal(asset.headers["content-type"], "image/svg+xml");
  assert.equal(asset.headers["x-content-type-options"], "nosniff");
  assert.match(String(asset.headers["cache-control"]), /private, no-cache/);
  assert.equal(
    (await get("/app.webmanifest")).headers["content-type"],
    "application/manifest+json",
  );
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

  const serverFile = path.join(project, "server", "index.ts");
  const validServer = fs.readFileSync(serverFile);
  write(serverFile, "export default {");
  write(icon, "<svg>updated</svg>");
  await daemon.runtime.build(app);
  assert.ok(app.buildError);
  assert.equal((await get("/icons/note.svg")).text, svg);
  write(serverFile, validServer);
  await daemon.runtime.build(app);
  const updated = await get("/icons/note.svg", {
    headers: { "If-None-Match": String(asset.headers.etag) },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.text, "<svg>updated</svg>");
  assert.notEqual(updated.headers.etag, asset.headers.etag);
});

test("queries read committed data while an async mutation waits, including on rollback", async () => {
  const { daemon, project } = await fixture({ pollMs: 3_600_000 });
  write(
    path.join(project, "server", "index.ts"),
    `
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
  `,
  );
  const app = daemon.runtime.find("notes")!;
  const call = (kind: OperationKind, name: string, input: unknown = null) =>
    daemon.runtime.call(app, kind, name, input);
  await call("mutations", "save");
  const { promise: waiting, resolve: arrived } = Promise.withResolvers<ServerResponse>();
  const remote = http.createServer((_request, response) => arrived(response));
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => {
    remote.closeAllConnections();
    remote.close();
  });
  const remotePort = (remote.address() as AddressInfo).port;
  const mutation = assert.rejects(
    call("mutations", "slow", `http://127.0.0.1:${remotePort}`),
    /roll back/,
  );
  const response = await waiting;
  const expected = { value: "committed", all: [{ key: "value", value: "committed" }] };
  try {
    const snapshot = await Promise.race([
      call("queries", "read"),
      delay(2_000, undefined, { ref: false }).then(() =>
        assert.fail("Query waited for the mutation"),
      ),
    ]);
    assert.deepEqual(snapshot, expected);
    for (const name of ["set", "delete"]) {
      await assert.rejects(call("queries", name), /Queries cannot change data/);
    }
  } finally {
    response.end();
    await mutation;
  }
  assert.deepEqual(await call("queries", "read"), expected);
}, 10_000);

test("inspect reports the current build operations before the worker starts", async () => {
  const { daemon, home, project } = await fixture({ pollMs: 3_600_000 });
  const initial = await runCli<{
    revision: string;
    running: boolean;
    operations: Record<string, string[]>;
  }>(home, "inspect", "notes");
  assert.deepEqual(initial.operations.queries, ["notes"]);
  assert.equal(initial.running, false);

  const source = path.join(project, "server", "index.ts");
  write(
    source,
    `
    export default {
      queries: { count() { return 0; }, invalid: true },
      mutations: { reset() {} },
      jobs: { check() {} },
    };
  `,
  );
  const app = daemon.runtime.find("notes")!;
  await until(() => app.revision !== initial.revision && !app.building);
  const expected = { queries: ["count"], mutations: ["reset"], jobs: ["check"] };
  const updated = await runCli<{
    revision: string;
    running: boolean;
    operations: Record<string, string[]>;
  }>(home, "inspect", "notes");
  assert.equal(updated.running, false);
  assert.deepEqual(updated.operations, expected);
  assert.deepEqual(
    read<{ operations: Record<string, string[]> }>(
      path.join(home, "builds", app.id, "current.json"),
      { operations: {} },
    ).operations,
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
    const cached = await runCli<{
      revision: string;
      running: boolean;
      error: string | null;
      operations: Record<string, string[]>;
    }>(home, "inspect", "notes");
    assert.equal(cached.revision, updated.revision);
    assert.equal(cached.running, false);
    assert.ok(cached.error);
    assert.deepEqual(cached.operations, expected);
  } finally {
    await restarted.close();
  }
});

test("client error reports require Gate and a matching origin, and fit within log limits", async () => {
  const { daemon, ca, home } = await fixture();
  const auth = await signin(daemon, ca);
  const report = (data: string, options?: Parameters<typeof request>[4]) =>
    request(daemon, ca, "notes.fleet", "/__fleet/client-error", {
      method: "POST",
      data,
      ...options,
    });
  assert.equal((await report('{"message":"anonymous"}')).status, 401);
  assert.equal(
    (
      await report('{"message":"wrong origin"}', {
        ...auth,
        origin: "https://other.fleet",
      })
    ).status,
    403,
  );
  assert.equal((await report("{}", auth)).status, 400);
  assert.equal((await report(JSON.stringify({ message: "x".repeat(4096) }), auth)).status, 413);
  const saved = await report(JSON.stringify({ message: "Startup failed\r\nnewline" }), auth);
  assert.equal(saved.status, 204);
  assert.equal(saved.text, "");
  for (let i = 0; i < 7; i++) {
    assert.equal((await report('{"message":"repeat"}', auth)).status, 204);
  }
  assert.equal((await report('{"message":"rate limited"}', auth)).status, 429);
  const { lines } = await runCli<{ lines: string[] }>(home, "logs", "notes");
  const reports = lines.filter((line) => line.includes("Client error: "));
  assert.equal(reports.length, 8);
  assert.match(reports[0], /Client error: Startup failed newline$/);
  assert.doesNotMatch(lines.join("\n"), /anonymous|wrong origin|rate limited/);
  assert.equal(daemon.runtime.find("notes")?.worker, null);
});

test("Gate, cached frontend, persistent data, idle unload, CSRF, and revocation work together", async () => {
  const { daemon, ca, home } = await fixture();
  assert.equal((await request(daemon, ca, "notes.fleet")).status, 303);
  const auth = await signin(daemon, ca);
  assert.equal((await request(daemon, ca, "notes.fleet", "/", auth)).status, 200);
  const bundle = await request(daemon, ca, "notes.fleet", "/app.js", auth);
  assert.equal(bundle.status, 200);
  assert.match(bundle.text, /function/);
  assert.ok(bundle.text.length > 1000);
  const page = await request(daemon, ca, "notes.fleet", "/", auth);
  const asset = /src="(\/app\.js\?v=[0-9a-f]+)"/.exec(page.text)![1];
  const versioned = await request(daemon, ca, "notes.fleet", asset, {
    ...auth,
    headers: { "Accept-Encoding": "gzip, br" },
  });
  assert.equal(versioned.headers["content-encoding"], "br");
  assert.match(String(versioned.headers["cache-control"]), /immutable/);
  assert.ok(versioned.raw.length < bundle.raw.length / 2);
  assert.equal(zlib.brotliDecompressSync(versioned.raw).toString(), bundle.text);
  const gzip = await request(daemon, ca, "notes.fleet", asset, {
    ...auth,
    headers: { "Accept-Encoding": "gzip, br;q=0" },
  });
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.match(String(bundle.headers["cache-control"]), /no-cache/);
  const unchanged = await request(daemon, ca, "notes.fleet", "/app.js", {
    ...auth,
    headers: { "If-None-Match": String(bundle.headers.etag) },
  });
  assert.equal(unchanged.status, 304);
  const post = (op: string, input: unknown, origin?: string) =>
    request(daemon, ca, "notes.fleet", `/__fleet/api/${op}`, {
      ...auth,
      origin,
      method: "POST",
      data: JSON.stringify(input),
    });
  assert.equal((await post("mutations/addNote", { text: "Persistent personal data" })).status, 200);
  assert.equal(
    (await post("mutations/addNote", { text: "Bad origin" }, "https://other.fleet")).status,
    403,
  );
  const app = daemon.runtime.find("notes")!;
  await until(() => !app.worker);
  assert.ok(fs.existsSync(path.join(home, "data", app.id, "app.sqlite")));
  const response = await post("queries/notes", null);
  assert.equal(response.status, 200, response.text);
  assert.equal(
    (JSON.parse(response.text) as { value: Array<{ text: string }> }).value[0].text,
    "Persistent personal data",
  );
  assert.equal((await post("mutations/toString", null)).status, 500);
  const replay = new URL(auth.ticket);
  assert.equal(
    (await request(daemon, ca, "notes.fleet", replay.pathname + replay.search)).status,
    303,
  );
  daemon.gate.reset();
  assert.equal((await post("queries/notes", null)).status, 401);
  await assert.rejects(
    request(daemon, ca, "unknown.fleet"),
    /TLS|socket|alert|ECONNRESET|disconnected|closed/i,
  );
});

test("waking an idle app waits for its previous worker to exit", async () => {
  const { daemon } = await fixture({ pollMs: 3_600_000 });
  const { runtime } = daemon;
  const app = runtime.find("notes")!;
  const saved = await runtime.call(app, "mutations", "addNote", {
    text: "Keep this on wake",
  });
  const previous = app.worker!;
  const terminate = previous.terminate.bind(previous);
  const { promise: canExit, resolve: release } = Promise.withResolvers<void>();
  const stopping = canExit.then(() => terminate());
  const spy = spyOn(previous, "terminate").mockImplementation(() => stopping);
  cleanups.push(() => spy.mockRestore());
  let query: Promise<unknown> | undefined;
  let notes: unknown;
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
