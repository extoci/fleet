import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import {
  encodeEventPayload,
  eventRetryDelay,
  MAX_EVENT_ATTEMPTS,
  MAX_EVENT_DEPTH,
  MAX_PENDING_EVENTS,
  matchesEventPattern,
  validateEventPattern,
  validateEventTopic,
} from "../src/events.ts";
import { peerRequest } from "../src/peers.ts";
import { start } from "../src/server.ts";
import { read, write } from "../src/state.ts";
import {
  cleanups,
  fixture,
  request,
  runCli,
  signin,
  streamEvents,
  until,
} from "./integration-helpers.ts";

test("event topic and wildcard pattern validation and matching", () => {
  assert.equal(validateEventTopic("workout.logged"), "workout.logged");
  assert.equal(validateEventTopic("alert_1.high-cpu"), "alert_1.high-cpu");
  for (const bad of ["", "alert.*", "*", ".leading", "trailing.", "a..b", "has space", "a/b"]) {
    assert.throws(() => validateEventTopic(bad));
  }

  assert.equal(validateEventPattern("*"), "*");
  assert.equal(validateEventPattern("alert.*"), "alert.*");
  assert.equal(validateEventPattern("workout.logged"), "workout.logged");
  for (const bad of ["", "*.alert", "a.*.b", "alert*", "a..*", "has space"]) {
    assert.throws(() => validateEventPattern(bad));
  }

  assert.equal(matchesEventPattern("workout.logged", "workout.logged"), true);
  assert.equal(matchesEventPattern("workout.logged", "workout.deleted"), false);
  assert.equal(matchesEventPattern("alert.*", "alert.cpu"), true);
  assert.equal(matchesEventPattern("alert.*", "alert.disk.full"), true);
  assert.equal(matchesEventPattern("alert.*", "alert"), false);
  assert.equal(matchesEventPattern("alert.*", "alerts.cpu"), false);
  assert.equal(matchesEventPattern("*", "anything.at.all"), true);

  assert.equal(eventRetryDelay(1), 5_000);
  assert.equal(eventRetryDelay(2), 15_000);
  assert.equal(eventRetryDelay(3), 45_000);
  assert.ok(eventRetryDelay(10) <= 15 * 60_000);

  // UTF-8 byte length is enforced (multi-byte characters cannot slip past 512 KB).
  assert.throws(() => encodeEventPayload({ text: "😀".repeat(150_000) }), /512 KB/);
});

test("ctx.emit wakes subscribed apps, matches wildcards, stays atomic on rollback, and pushes SSE data updates", async () => {
  const { daemon, ca, home, project } = await fixture({ pollMs: 3_600_000 });

  write(
    path.join(project, "server", "index.ts"),
    `
    export default {
      queries: {
        badEmit(ctx) {
          ctx.emit("workout.logged", { minutes: 10 });
          return true;
        },
      },
      mutations: {
        logWorkout(ctx, input) {
          ctx.db.set("last", input);
          ctx.emit("workout.logged", { minutes: input.minutes });
          if (input.alert) ctx.emit("alert.heartrate", { bpm: 195 });
          return { ok: true };
        },
        failAfterEmit(ctx) {
          ctx.db.set("shouldRollback", true);
          ctx.emit("workout.logged", { minutes: 999 });
          throw new Error("boom");
        },
      },
    };
    `,
  );

  const journalDir = path.join(home, "journal");
  await runCli(home, "init", journalDir, "--service");
  write(
    path.join(journalDir, "server", "index.ts"),
    `
    export default {
      queries: {
        entries(ctx) {
          return ctx.db.get("entries") ?? [];
        },
        alerts(ctx) {
          return ctx.db.get("alerts") ?? [];
        },
      },
      events: {
        "workout.logged"(ctx, payload) {
          const entries = ctx.db.get("entries") ?? [];
          ctx.db.set("entries", [
            ...entries,
            {
              eventId: ctx.eventId,
              topic: ctx.event.topic,
              source: ctx.event.source,
              depth: ctx.event.depth,
              minutes: payload.minutes,
            },
          ]);
        },
        "alert.*"(ctx, payload) {
          const alerts = ctx.db.get("alerts") ?? [];
          ctx.db.set("alerts", [...alerts, { topic: ctx.event.topic, payload }]);
        },
      },
    };
    `,
  );

  await daemon.runtime.tick();
  await daemon.runtime.settleBuilds();

  const notesApp = daemon.runtime.find("notes")!;
  const journalApp = daemon.runtime.find("journal")!;
  assert.equal(journalApp.hasClient, false);
  assert.equal(journalApp.worker, null);

  await assert.rejects(
    () => daemon.runtime.call(notesApp, "queries", "badEmit", null),
    /Queries cannot emit events/,
  );

  await assert.rejects(
    () => daemon.runtime.call(notesApp, "mutations", "failAfterEmit", null),
    /boom/,
  );
  await daemon.runtime.settleEvents();
  assert.equal(journalApp.worker, null);
  assert.deepEqual(await daemon.runtime.call(journalApp, "queries", "entries", null), []);

  daemon.runtime.unload(journalApp);
  const auth = await signin(daemon, ca, "journal");
  const stream = await streamEvents(daemon, ca, "journal.fleet", { cookie: auth.cookie });
  cleanups.push(stream.close);
  await until(() => stream.events.length >= 1);

  await daemon.runtime.call(notesApp, "mutations", "logWorkout", { minutes: 45, alert: true });
  await daemon.runtime.settleEvents();
  await until(() => stream.events.some((event) => event.type === "data"));

  const entries = (await daemon.runtime.call(journalApp, "queries", "entries", null)) as Array<{
    eventId: string;
    topic: string;
    source: string;
    depth: number;
    minutes: number;
  }>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].topic, "workout.logged");
  assert.equal(entries[0].source, "notes");
  assert.equal(entries[0].depth, 0);
  assert.equal(entries[0].minutes, 45);
  assert.ok(entries[0].eventId.length > 0);

  const alerts = (await daemon.runtime.call(journalApp, "queries", "alerts", null)) as Array<{
    topic: string;
    payload: { bpm: number };
  }>;
  assert.deepEqual(alerts, [{ topic: "alert.heartrate", payload: { bpm: 195 } }]);
});

test("failed event deliveries retry with backoff using the same eventId and cap attempts", async () => {
  const { daemon, project } = await fixture({ pollMs: 3_600_000 });
  write(
    path.join(project, "server", "index.ts"),
    `
    export default {
      queries: {
        seen(ctx) {
          return ctx.db.get("seen") ?? [];
        },
      },
      events: {
        "job.ping"(ctx, payload) {
          ctx.log("attempt", ctx.eventId, payload.mode);
          if (payload.mode === "alwaysFail") {
            throw new Error("permanent failure");
          }
          if (payload.mode === "flaky" && !ctx.db.get("okNow")) {
            throw new Error("transient failure");
          }
          ctx.db.set("seen", [...(ctx.db.get("seen") ?? []), { id: ctx.eventId }]);
        },
      },
      mutations: {
        allowSuccess(ctx) {
          ctx.db.set("okNow", true);
        },
      },
    };
    `,
  );

  const app = daemon.runtime.find("notes")!;
  await daemon.runtime.settleBuild(app);

  const flaky = daemon.runtime.emitEvent("cli", "job.ping", { mode: "flaky" });
  await daemon.runtime.settleEvents();
  const afterFail = daemon.runtime.readEventStore();
  assert.equal(afterFail.pending.length, 1);
  assert.equal(afterFail.pending[0].eventId, flaky.eventId);
  assert.equal(afterFail.pending[0].failures, 1);
  assert.match(afterFail.pending[0].error || "", /transient failure/);

  await daemon.runtime.call(app, "mutations", "allowSuccess", null);
  afterFail.pending[0].due = Date.now() - 1;
  daemon.runtime.writeEventStore(afterFail);
  await daemon.runtime.tick();
  await daemon.runtime.settleEvents();

  assert.equal(daemon.runtime.readEventStore().pending.length, 0);
  const seen = (await daemon.runtime.call(app, "queries", "seen", null)) as Array<{ id: string }>;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, flaky.eventId);

  const doomed = daemon.runtime.emitEvent("cli", "job.ping", { mode: "alwaysFail" });
  await daemon.runtime.settleEvents();
  for (let i = 1; i < MAX_EVENT_ATTEMPTS; i++) {
    const store = daemon.runtime.readEventStore();
    assert.equal(store.pending.length, 1);
    store.pending[0].due = Date.now() - 1;
    daemon.runtime.writeEventStore(store);
    await daemon.runtime.tick();
    await daemon.runtime.settleEvents();
  }
  const finalStore = daemon.runtime.readEventStore();
  assert.equal(finalStore.pending.length, 0);
  const failedRecord = finalStore.recent.find((r) => r.eventId === doomed.eventId);
  assert.ok(failedRecord);
  assert.equal(failedRecord.status, "failed");
  assert.equal(failedRecord.attempts, MAX_EVENT_ATTEMPTS);
});

test("cyclic events stop at max hop depth instead of looping forever", async () => {
  const { daemon, project } = await fixture({ pollMs: 3_600_000 });
  write(
    path.join(project, "server", "index.ts"),
    `
    export default {
      queries: {
        depths(ctx) {
          return ctx.db.get("depths") ?? [];
        },
      },
      events: {
        "loop.ping"(ctx) {
          const depths = ctx.db.get("depths") ?? [];
          ctx.db.set("depths", [...depths, ctx.event.depth]);
          ctx.emit("loop.ping", { next: ctx.event.depth + 1 });
        },
      },
    };
    `,
  );

  const app = daemon.runtime.find("notes")!;
  await daemon.runtime.settleBuild(app);

  daemon.runtime.emitEvent("cli", "loop.ping", { next: 0 });
  await daemon.runtime.settleEvents();

  const depths = (await daemon.runtime.call(app, "queries", "depths", null)) as number[];
  assert.deepEqual(
    depths,
    Array.from({ length: MAX_EVENT_DEPTH }, (_, i) => i),
  );
  const dropped = daemon.runtime.readEventStore().recent.find((r) => r.status === "dropped");
  assert.ok(dropped);
  assert.equal(dropped.topic, "loop.ping");
});

test("headless service init, service page, fleet check, fleet emit, fleet events, and upgrading to a client app", async () => {
  const { daemon, ca, home } = await fixture({ pollMs: 3_600_000 });
  const svcDir = path.join(home, "notify");
  const initOut = await runCli<{ name: string; service: boolean; url: string }>(
    home,
    "init",
    svcDir,
    "--service",
  );
  assert.equal(initOut.name, "notify");
  assert.equal(initOut.service, true);
  assert.equal(fs.existsSync(path.join(svcDir, "client")), false);
  assert.equal(fs.existsSync(path.join(svcDir, "server", "index.ts")), true);

  const checkOut = await runCli<{ ok: boolean }>(home, "check", "notify");
  assert.equal(checkOut.ok, true);

  const inspected = await runCli<{
    hasClient: boolean;
    revision: string | null;
    error: string | null;
    operations: { events: string[] };
  }>(home, "inspect", "notify", "--wait");
  assert.equal(inspected.hasClient, false);
  assert.ok(inspected.revision);
  assert.equal(inspected.error, null);
  assert.deepEqual(inspected.operations.events, ["service.ping"]);

  const auth = await signin(daemon, ca, "notify");
  const page = await request(daemon, ca, "notify.fleet", "/", auth);
  assert.equal(page.status, 200);
  assert.match(page.text, /notify <span>service<\/span>/);
  assert.match(page.text, /service\.ping/);

  const emitted = await runCli<{
    topic: string;
    matched: number;
    targets: Array<{ app: string; handler: string }>;
  }>(home, "emit", "service.ping", '{"hello":"world"}');
  assert.equal(emitted.topic, "service.ping");
  assert.equal(emitted.matched, 1);
  assert.deepEqual(emitted.targets, [{ app: "notify", handler: "service.ping" }]);

  await daemon.runtime.settleEvents();
  const recent = await runCli<{
    value: Array<{ topic: string; source: string; payload: { hello: string } }>;
  }>(home, "call", "notify", "queries", "recent");
  assert.equal(recent.value.length, 1);
  assert.equal(recent.value[0].topic, "service.ping");
  assert.equal(recent.value[0].source, "cli");
  assert.deepEqual(recent.value[0].payload, { hello: "world" });

  const eventsStatus = await runCli<{
    subscriptions: Array<{ pattern: string; app: string }>;
    recent: Array<{ topic: string; status: string }>;
  }>(home, "events");
  assert.ok(
    eventsStatus.subscriptions.some((s) => s.pattern === "service.ping" && s.app === "notify"),
  );
  assert.ok(
    eventsStatus.recent.some((r) => r.topic === "service.ping" && r.status === "delivered"),
  );

  write(
    path.join(svcDir, "client", "index.tsx"),
    `import { render } from "preact"; render(<h1>Now has UI</h1>, document.getElementById("app")!);`,
  );
  const upgraded = await runCli<{ hasClient: boolean; error: string | null }>(
    home,
    "inspect",
    "notify",
    "--wait",
  );
  assert.equal(upgraded.hasClient, true);
  assert.equal(upgraded.error, null);
  const appHtml = await request(daemon, ca, "notify.fleet", "/", auth);
  assert.equal(appHtml.status, 200);
  assert.match(appHtml.text, /\/app\.js\?v=/);
});

test("invalid event subscription pattern fails validation without breaking the running build", async () => {
  const { daemon, project } = await fixture({ pollMs: 3_600_000 });
  const app = daemon.runtime.find("notes")!;
  const before = app.revision;
  assert.ok(before);

  write(
    path.join(project, "server", "index.ts"),
    `
    export default {
      events: {
        "bad.*.pattern"(ctx) {
          ctx.log("nope");
        },
      },
    };
    `,
  );
  await daemon.runtime.settleBuild(app);
  assert.equal(app.revision, before);
  assert.match(app.buildError || "", /Event subscriptions must be/);
});

test("events fan out between gateway and peer computers in both directions", async () => {
  const {
    daemon: gateway,
    home: gatewayHome,
    project: gatewayAppDir,
  } = await fixture({
    pollMs: 3_600_000,
    allowLoopbackPeers: true,
  });

  write(
    path.join(gatewayAppDir, "server", "index.ts"),
    `
    export default {
      queries: {
        inbox(ctx) {
          return ctx.db.get("inbox") ?? [];
        },
      },
      mutations: {
        send(ctx) {
          ctx.emit("gateway.ping", { from: "gateway" });
          return true;
        },
      },
      events: {
        "peer.*"(ctx, payload) {
          ctx.db.set("inbox", [...(ctx.db.get("inbox") ?? []), { topic: ctx.event.topic, payload }]);
        },
      },
    };
    `,
  );
  const gatewayApp = gateway.runtime.find("notes")!;
  await gateway.runtime.settleBuild(gatewayApp);

  const nodeHome = path.join(gatewayHome, "node-home");
  const inviteFile = path.join(gatewayHome, "invite.json");
  await runCli(gatewayHome, "invite", "--output", inviteFile);
  const invite = JSON.parse(fs.readFileSync(inviteFile, "utf8")) as Record<string, unknown>;
  invite.address = "127.0.0.1";
  invite.port = gateway.httpsPort;
  fs.writeFileSync(inviteFile, JSON.stringify(invite));

  const peerAppDir = path.join(nodeHome, "worker");
  await runCli(nodeHome, "setup", "--local");
  const nodeConfig = JSON.parse(
    fs.readFileSync(path.join(nodeHome, "config.json"), "utf8"),
  ) as Record<string, unknown>;
  nodeConfig.mode = "node";
  nodeConfig.nodeId = "11111111-1111-4111-8111-111111111111";
  nodeConfig.nodeToken = "t".repeat(48);
  nodeConfig.gateway = {
    address: "127.0.0.1",
    port: gateway.httpsPort,
    ca: invite.ca,
    joinToken: invite.token,
  };
  write(path.join(nodeHome, "config.json"), nodeConfig);

  await runCli(nodeHome, "init", peerAppDir, "--service");
  write(
    path.join(peerAppDir, "server", "index.ts"),
    `
    export default {
      queries: {
        received(ctx) {
          return ctx.db.get("received") ?? [];
        },
      },
      mutations: {
        notifyGateway(ctx) {
          ctx.emit("peer.done", { ok: true });
          return true;
        },
      },
      events: {
        "gateway.ping"(ctx, payload) {
          ctx.db.set("received", [...(ctx.db.get("received") ?? []), payload]);
        },
      },
    };
    `,
  );

  const node = await start(nodeHome, {
    hosts: ["127.0.0.1"],
    nodePort: 0,
    adminPort: 0,
    noDns: true,
    pollMs: 3_600_000,
    allowLoopbackPeers: true,
  });
  cleanups.push(() => node.close());

  await until(async () => {
    const status = await runCli<{
      subscriptions: Array<{ pattern: string; app: string; peer?: string }>;
    }>(gatewayHome, "events");
    return status.subscriptions.some((s) => s.app === "worker" && s.pattern === "gateway.ping");
  });

  await gateway.runtime.call(gatewayApp, "mutations", "send", null);
  const peerApp = node.runtime.find("worker")!;
  await until(async () => {
    const rows = (await node.runtime.call(peerApp, "queries", "received", null)) as unknown[];
    return rows.length === 1;
  });

  await node.runtime.call(peerApp, "mutations", "notifyGateway", null);
  await until(async () => {
    const rows = (await gateway.runtime.call(gatewayApp, "queries", "inbox", null)) as unknown[];
    return rows.length === 1;
  });
  const inbox = (await gateway.runtime.call(gatewayApp, "queries", "inbox", null)) as Array<{
    topic: string;
    payload: { ok: boolean };
  }>;
  assert.deepEqual(inbox, [{ topic: "peer.done", payload: { ok: true } }]);

  // Peer spoofing an app it does not own is rejected with 403
  await assert.rejects(
    () =>
      peerRequest(
        {
          address: "127.0.0.1",
          port: gateway.httpsPort,
          ca: invite.ca as string,
          token: nodeConfig.nodeToken as string,
          route: "/__fleet/peers/event",
        },
        "event",
        {
          peerId: nodeConfig.nodeId,
          event: {
            id: "spoof-1",
            topic: "peer.spoof",
            source: "notes",
            at: new Date().toISOString(),
            depth: 0,
          },
          payload: null,
        },
      ),
    /not authorized to emit as that source/i,
  );

  // Legacy peers.json records without hasClient default to true (not headless)
  const peersFile = path.join(gatewayHome, "peers.json");
  const storedPeers = read<Array<{ apps: Array<Record<string, unknown>> }>>(peersFile, []);
  delete storedPeers[0].apps[0].hasClient;
  write(peersFile, storedPeers);
  const listed = await runCli<Array<{ name: string; hasClient: boolean }>>(gatewayHome, "list");
  assert.equal(listed.find((a) => a.name === "worker")?.hasClient, true);
});

test("bursts throttle cleanly without burning retries, capacity refuses without evicting, and removed handlers drop", async () => {
  const { daemon, project } = await fixture({ pollMs: 3_600_000 });
  write(
    path.join(project, "server", "index.ts"),
    `
    export default {
      queries: {
        count(ctx) {
          return ctx.db.get("count") ?? 0;
        },
      },
      events: {
        "burst.item"(ctx) {
          ctx.db.set("count", (ctx.db.get("count") ?? 0) + 1);
        },
        "will.remove"(ctx) {
          throw new Error("temporary");
        },
      },
    };
    `,
  );
  const app = daemon.runtime.find("notes")!;
  await daemon.runtime.settleBuild(app);

  // 40 concurrent emits exceed the worker's 32-call limit if unthrottled; all must succeed on attempt 1
  for (let i = 0; i < 40; i++) {
    daemon.runtime.emitEvent("cli", "burst.item", { i });
  }
  await daemon.runtime.settleEvents();
  assert.equal(await daemon.runtime.call(app, "queries", "count", null), 40);
  const recentBurst = daemon.runtime
    .readEventStore()
    .recent.filter((entry) => entry.topic === "burst.item");
  assert.ok(recentBurst.length > 0);
  assert.ok(recentBurst.every((entry) => entry.status === "delivered" && entry.attempts === 1));

  // Removed handler drops pending retry to recent instead of stranding forever
  daemon.runtime.emitEvent("cli", "will.remove", null);
  await daemon.runtime.settleEvents();
  assert.equal(daemon.runtime.readEventStore().pending.length, 1);

  write(
    path.join(project, "server", "index.ts"),
    `
    export default {
      events: {
        "burst.item"(ctx) {
          ctx.db.set("count", (ctx.db.get("count") ?? 0) + 1);
        },
      },
    };
    `,
  );
  await daemon.runtime.settleBuild(app);
  await daemon.runtime.tick();
  const afterRemove = daemon.runtime.readEventStore();
  assert.equal(afterRemove.pending.length, 0);
  const dropped = afterRemove.recent.find(
    (entry) => entry.topic === "will.remove" && entry.status === "dropped",
  );
  assert.ok(dropped);
  assert.match(dropped.error || "", /removed/i);

  // Full queue rejects new work explicitly without evicting accepted deliveries
  const filled = Array.from({ length: MAX_PENDING_EVENTS }, (_, i) => ({
    id: `queued-${i}`,
    eventId: `evt-${i}`,
    topic: "burst.item",
    source: "cli",
    payload: null,
    at: new Date().toISOString(),
    depth: 0,
    targetAppId: app.id,
    targetAppName: app.name,
    handler: "burst.item",
    due: Date.now() + 3_600_000,
    failures: 0,
  }));
  daemon.runtime.writeEventStore({ pending: filled, recent: [] });
  assert.throws(
    () => daemon.runtime.emitEvent("cli", "burst.item", { overflow: true }),
    /capacity/,
  );
  const preserved = daemon.runtime.readEventStore().pending;
  assert.equal(preserved.length, MAX_PENDING_EVENTS);
  assert.equal(preserved[0].id, "queued-0");
});
