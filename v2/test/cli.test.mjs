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
