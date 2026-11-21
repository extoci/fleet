import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../src/runtime.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-live-"));
  const project = path.join(home, "notes");
  execFileSync(process.execPath, [cli, "init", project, "--json"], {
    env: { ...process.env, FLEET_V2_HOME: home },
    stdio: "pipe",
  });
  const runtime = new Runtime(home, { pollMs: 3_600_000 });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  });
  const app = runtime.find("notes");
  assert.ok(await runtime.build(app));
  return { app, runtime, project };
}

test("an edit rebuilds the app and announces it without waiting for a tick", async (t) => {
  const { app, runtime, project } = await fixture(t);
  const first = app.revision;
  const announced = new Promise((resolve) =>
    runtime.onRevision((built) => built === app && resolve(built.revision)),
  );
  await delay(100);
  fs.appendFileSync(path.join(project, "client", "index.tsx"), "\n// edit\n");
  const revision = await Promise.race([
    announced,
    delay(5000, undefined, { ref: false }).then(() => assert.fail("No rebuild after the edit.")),
  ]);
  assert.notEqual(revision, first);
});

test("nearby edits to different files rebuild once even when ticks run between them", async (t) => {
  const { app, runtime, project } = await fixture(t);
  // Schedule edits directly so file watcher delivery cannot race a tick.
  app.watcher?.close();
  app.watcher = null;
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const revisions = [];
  runtime.onRevision((built) => revisions.push(built.revision));
  const first = app.revision;
  const edit = (file) => {
    fs.appendFileSync(path.join(project, "client", file), "\n/* edit */\n");
    app.dirty = true;
    runtime.scheduleBuild(app);
  };

  edit("index.tsx");
  await runtime.tick();
  assert.equal(app.revision, first);
  t.mock.timers.tick(200);
  assert.equal(app.building, null);

  edit("style.css");
  await runtime.tick();
  assert.equal(app.revision, first);
  t.mock.timers.tick(50);
  assert.equal(app.building, null);

  t.mock.timers.tick(200);
  t.mock.timers.reset();
  assert.equal(await app.building, true);
  assert.notEqual(app.revision, first);
  assert.deepEqual(revisions, [app.revision]);
});
