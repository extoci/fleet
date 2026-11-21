import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { start } from "../src/server.mjs";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const exec = promisify(execFile);

test("init writes public source and agent guidance while keeping Fleet state and secrets private", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-init-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "state");
  const app = path.join(temporary, "notes");
  const init = (dir) =>
    exec(process.execPath, [
      "--import=data:text/javascript,process.umask(0o022)",
      cli,
      "--home",
      home,
      "init",
      dir,
    ]);
  await init(app);
  const mode = (file) => fs.statSync(file).mode & 0o777;
  for (const dir of ["client", "server"])
    assert.equal(mode(path.join(app, dir)), 0o755);
  for (const file of [
    "client/index.tsx",
    "client/style.css",
    "server/index.ts",
    "fleet.json",
    "fleet.d.ts",
  ])
    assert.equal(mode(path.join(app, file)), 0o644, file);
  assert.equal(mode(path.join(app, ".env.fleet.server")), 0o600);
  assert.equal(mode(home), 0o700);
  assert.equal(mode(path.join(home, "apps.json")), 0o600);
  const types = path.join(app, "fleet.d.ts");
  assert.match(fs.readFileSync(types, "utf8"), /declare module "fleet\/client"/);
  const agents = fs.readFileSync(path.join(app, "AGENTS.md"), "utf8");
  assert.match(agents, /Do not install Preact/);
  assert.match(agents, /get returns null/);
  assert.match(agents, /list\(prefix\) returns up to 1,000 items/);
  assert.match(agents, /rolls back all ctx.db writes/);
  assert.match(agents, /call\(kind, name, input\)/);

  fs.unlinkSync(types);
  await init(app);
  assert.match(fs.readFileSync(types, "utf8"), /interface FleetCtx/);
  const existing = path.join(temporary, "existing");
  fs.mkdirSync(existing);
  const existingTypes = path.join(existing, "fleet.d.ts");
  fs.writeFileSync(existingTypes, "// Custom types\n");
  await init(existing);
  await init(existing);
  assert.equal(fs.readFileSync(existingTypes, "utf8"), "// Custom types\n");
});

async function setupLocal(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (...args) =>
    exec(process.execPath, [cli, "--home", home, ...args], { timeout: 10_000 });
  await run("setup", "--local");
  return { home, run };
}

test("local doctor skips network prerequisites but fails if the daemon is down", async (t) => {
  const { home, run } = await setupLocal(t);
  const daemon = await start(home, { httpsPort: 0, dnsPort: 0, adminPort: 0 });
  try {
    const { stdout } = await run("doctor", "--json");
    const [tailscale, daemonCheck, dns] = JSON.parse(stdout);
    assert.deepEqual(daemonCheck, { check: "daemon", ok: true, apps: 0 });
    for (const [check, name] of [
      [tailscale, "tailscale"],
      [dns, "system-dns"],
    ]) {
      assert.equal(check.check, name);
      assert.equal(check.skipped, true);
      assert.equal(check.ok, null);
    }
  } finally {
    await daemon.close();
  }

  await assert.rejects(run("doctor", "--json"), (error) => {
    assert.equal(error.code, 1);
    assert.deepEqual(
      JSON.parse(error.stdout)
        .filter((check) => check.ok === false)
        .map((check) => check.check),
      ["daemon"],
    );
    return true;
  });
});

test("local phone off is a successful no-op without a phone route", async (t) => {
  const { run } = await setupLocal(t);
  const { stdout } = await run("phone", "off", "--json");
  assert.equal(
    JSON.parse(stdout),
    "There is no Fleet phone setup route to remove.",
  );
});
