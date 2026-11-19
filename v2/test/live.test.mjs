import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Runtime } from "../src/runtime.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("an edit rebuilds the app and announces it without waiting for a tick", async (t) => {
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
  const first = app.revision;
  const announced = new Promise((resolve) =>
    runtime.onRevision((built) => built === app && resolve(built.revision)),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.appendFileSync(path.join(project, "client", "index.tsx"), "\n// edit\n");
  const revision = await Promise.race([
    announced,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("No rebuild after the edit.")), 5000),
    ),
  ]);
  assert.notEqual(revision, first);
});
