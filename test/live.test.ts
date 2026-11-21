import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, jest, test } from "bun:test";
import { Runtime } from "../src/runtime.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  jest.useRealTimers();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-live-"));
  const project = path.join(home, "notes");
  execFileSync(process.execPath, [cli, "init", project, "--json"], {
    env: { ...process.env, FLEET_V2_HOME: home },
    stdio: "pipe",
  });
  const runtime = new Runtime(home, { pollMs: 3_600_000 });
  cleanups.push(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10 });
  });
  const app = runtime.find("notes");
  assert.ok(app);
  assert.ok(await runtime.build(app));
  return { app, runtime, project };
}

test("an edit rebuilds the app and announces it without waiting for a tick", async () => {
  const { app, runtime, project } = await fixture();
  const first = app.revision;
  const announced = new Promise<string | undefined>((resolve) =>
    runtime.onRevision((built) => {
      if (built === app) resolve(built.revision);
    }),
  );
  await delay(100);
  fs.appendFileSync(path.join(project, "client", "index.tsx"), "\n// edit\n");
  const revision = await Promise.race([
    announced,
    delay(5000, undefined, { ref: false }).then(() => assert.fail("No rebuild after the edit.")),
  ]);
  assert.notEqual(revision, first);
});

test("nearby edits to different files rebuild once even when ticks run between them", async () => {
  const { app, runtime, project } = await fixture();
  // Schedule edits directly so file watcher delivery cannot race a tick.
  app.watcher?.close();
  app.watcher = null;
  jest.useFakeTimers();

  const revisions: Array<string | undefined> = [];
  runtime.onRevision((built) => revisions.push(built.revision));
  const first = app.revision;
  const edit = (file: string) => {
    fs.appendFileSync(path.join(project, "client", file), "\n/* edit */\n");
    app.dirty = true;
    runtime.scheduleBuild(app);
  };

  edit("index.tsx");
  await runtime.tick();
  assert.equal(app.revision, first);
  jest.advanceTimersByTime(200);
  assert.equal(app.building, null);

  edit("style.css");
  await runtime.tick();
  assert.equal(app.revision, first);
  jest.advanceTimersByTime(50);
  assert.equal(app.building, null);

  jest.advanceTimersByTime(200);
  jest.useRealTimers();
  assert.equal(await app.building, true);
  assert.notEqual(app.revision, first);
  assert.deepEqual(revisions, [app.revision]);
});
