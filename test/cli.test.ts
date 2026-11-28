import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "bun:test";
import {
  formatAppList,
  formatDoctor,
  formatGateCode,
  formatHelp,
  formatInit,
  formatInspect,
  renderWordmarkBanner,
} from "../src/cli-ui.ts";
import { start } from "../src/server.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const exec = promisify(execFile);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

test("help includes jobs as a fleet call operation kind and fleet agent pointer", async () => {
  const { stdout } = await exec(process.execPath, [cli, "--help"]);
  assert.match(stdout, /fleet init \[directory\] \[--service\]/);
  assert.match(stdout, /fleet call APP queries\|mutations\|jobs OP \[JSON\]/);
  assert.match(stdout, /fleet emit TOPIC \[JSON\]/);
  assert.match(stdout, /fleet events \[--json\]/);
  assert.match(stdout, /fleet agent \[--install\]/);
  assert.match(stdout, /fleet gate sessions/);
  assert.match(stdout, /fleet gate revoke ID/);
  assert.match(stdout, /fleet peers/);
  assert.match(stdout, /fleet peers remove ID/);
  assert.match(stdout, /fleet inspect NAME \[--wait\]/);
  assert.match(stdout, /fleet logs NAME \[-n LINES\] \[-f\]/);
  assert.match(stdout, /fleet logs --daemon/);
  assert.match(stdout, /fleet check NAME/);
  assert.match(stdout, /Agents: fleet agent/);
});

test("fleet agent prints the shared contract and installs SKILL.md", async () => {
  const { stdout } = await exec(process.execPath, [cli, "agent"]);
  assert.match(stdout, /A Fleet app is a directory anywhere on this computer/);
  assert.match(stdout, /scaffold a directory with `fleet init`/);
  assert.match(stdout, /## Fleet app/);
  assert.match(
    stdout,
    /When explicitly asked to update Fleet, run `fleet update`, then run `fleet agent --install`/,
  );
  assert.match(stdout, /Keep this app in git/);
  assert.match(
    stdout,
    /First-time setup: ask the user if they want to publish this repo \(private by default\)/,
  );
  assert.match(stdout, /You are done when fleet inspect NAME --wait reports a new revision/);

  const { stdout: jsonOut } = await exec(process.execPath, [cli, "agent", "--json"]);
  const parsed = JSON.parse(jsonOut) as { guide: string };
  assert.equal(parsed.guide, stdout.trimEnd() + "\n");

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-skill-"));
  cleanups.push(() => fs.rmSync(fakeHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, ".config", "devin"), { recursive: true });
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };

  const { stdout: installJson } = await exec(
    process.execPath,
    [cli, "agent", "--install", "--json"],
    {
      env,
    },
  );
  const { installed } = JSON.parse(installJson) as { installed: string[] };
  const expected = [
    path.resolve(fakeHome, ".agents", "skills", "fleet", "SKILL.md"),
    path.resolve(fakeHome, ".claude", "skills", "fleet", "SKILL.md"),
    path.resolve(fakeHome, ".config", "devin", "skills", "fleet", "SKILL.md"),
  ];
  assert.deepEqual(installed, expected);
  assert.equal(fs.existsSync(path.join(fakeHome, ".codex")), false);

  for (const file of expected) {
    const content = fs.readFileSync(file, "utf8");
    assert.match(content, /^---\nname: fleet\n/);
    assert.match(content, /A Fleet app is a directory anywhere on this computer/);
    assert.match(content, /## Fleet app/);
  }

  const customTarget = path.join(fakeHome, "custom", "SKILL.md");
  const { stdout: customOut } = await exec(
    process.execPath,
    [cli, "agent", "--install", "--output", customTarget, "--json"],
    { env },
  );
  assert.deepEqual(JSON.parse(customOut), { installed: [path.resolve(customTarget)] });
  assert.match(fs.readFileSync(customTarget, "utf8"), /^---\nname: fleet\n/);
});

test("version reports Fleet 2.x", async () => {
  const { stdout } = await exec(process.execPath, [cli, "--version"]);
  assert.match(stdout.trim(), /^Fleet 2\./);
});

test("init writes public source and agent guidance while keeping Fleet state and secrets private", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-init-"));
  cleanups.push(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "state");
  const app = path.join(temporary, "notes");
  const umaskPreload = path.join(temporary, "umask.ts");
  fs.writeFileSync(umaskPreload, "process.umask(0o022);\n");
  const init = (dir: string) =>
    exec(process.execPath, ["--preload", umaskPreload, cli, "--home", home, "init", dir]);
  await init(app);
  if (process.platform !== "win32") {
    const mode = (file: string) => fs.statSync(file).mode & 0o777;
    for (const dir of ["client", "server"]) {
      assert.equal(mode(path.join(app, dir)), 0o755);
    }
    for (const file of [
      "client/index.tsx",
      "client/style.css",
      "server/index.ts",
      "fleet.json",
      "fleet.d.ts",
    ]) {
      assert.equal(mode(path.join(app, file)), 0o644, file);
    }
    assert.equal(mode(path.join(app, ".env.fleet.server")), 0o600);
    assert.equal(mode(home), 0o700);
    assert.equal(mode(path.join(home, "apps.json")), 0o600);
  }
  const types = path.join(app, "fleet.d.ts");
  assert.match(fs.readFileSync(types, "utf8"), /declare module "fleet\/client"/);
  const agents = fs.readFileSync(path.join(app, "AGENTS.md"), "utf8");
  assert.match(agents, /Do not install Preact/);
  assert.match(agents, /get returns null/);
  assert.match(agents, /list\(prefix\) returns up to 1,000 items/);
  assert.match(agents, /rolls back all ctx.db writes/);
  assert.match(agents, /call\(kind, name, input\)/);
  assert.match(agents, /Keep this app in git/);
  assert.match(
    agents,
    /First-time setup: ask the user if they want to publish this repo \(private by default\)/,
  );
  assert.match(agents, /You are done when fleet inspect notes --wait reports a new revision/);

  fs.unlinkSync(types);
  await init(app);
  assert.match(fs.readFileSync(types, "utf8"), /interface FleetCtx/);
  assert.equal(fs.readFileSync(path.join(app, "AGENTS.md"), "utf8"), agents);
  const withoutFirstTime = agents.replace(/\nFirst-time setup:[^\n]+\n/, "\n");
  assert.notEqual(withoutFirstTime, agents);
  fs.writeFileSync(path.join(app, "AGENTS.md"), withoutFirstTime);
  await init(app);
  assert.equal(fs.readFileSync(path.join(app, "AGENTS.md"), "utf8"), withoutFirstTime);
  const existing = path.join(temporary, "existing");
  fs.mkdirSync(existing);
  const existingTypes = path.join(existing, "fleet.d.ts");
  fs.writeFileSync(existingTypes, "// Custom types\n");
  await init(existing);
  await init(existing);
  assert.equal(fs.readFileSync(existingTypes, "utf8"), "// Custom types\n");
});

test("fleet logs supports line counts, daemon logs, and following appended lines", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-logs-"));
  cleanups.push(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "state");
  const app = path.join(temporary, "notes");
  await exec(process.execPath, [cli, "--home", home, "init", app]);
  const manifest = JSON.parse(fs.readFileSync(path.join(app, "fleet.json"), "utf8")) as {
    id: string;
  };
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  const log = path.join(home, "logs", `${manifest.id}.log`);
  fs.writeFileSync(log, `${Array.from({ length: 150 }, (_, i) => `line${i + 1}`).join("\n")}\n`);
  const limited = await exec(process.execPath, [
    cli,
    "--home",
    home,
    "logs",
    "notes",
    "-n",
    "3",
    "--json",
  ]);
  assert.deepEqual(JSON.parse(limited.stdout), {
    name: "notes",
    lines: ["line148", "line149", "line150"],
  });

  fs.writeFileSync(path.join(home, "daemon.log"), "daemon one\ndaemon two\n");
  const daemon = await exec(process.execPath, [
    cli,
    "--home",
    home,
    "logs",
    "--daemon",
    "-n",
    "1",
    "--json",
  ]);
  assert.deepEqual(JSON.parse(daemon.stdout), { name: "daemon", lines: ["daemon two"] });

  const child = execFile(process.execPath, [cli, "--home", home, "logs", "notes", "-n", "1", "-f"]);
  let followed = "";
  child.stdout?.on("data", (chunk) => {
    followed += String(chunk);
  });
  const deadline = Date.now() + 5000;
  while (!followed.includes("line150") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fs.appendFileSync(log, "line151\n");
  while (!followed.includes("line151") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  assert.match(followed, /line150/);
  assert.match(followed, /line151/);
});

test("fleet check passes the starter app and reports type errors as JSON", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-check-"));
  cleanups.push(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, "state");
  const app = path.join(temporary, "notes");
  await exec(process.execPath, [cli, "--home", home, "init", app]);
  const passing = await exec(process.execPath, [cli, "--home", home, "check", "notes", "--json"]);
  const passed = JSON.parse(passing.stdout) as { ok: boolean; errors: string[] };
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.errors, []);

  fs.appendFileSync(path.join(app, "server", "index.ts"), "\nconst bad: string = 1;\n");
  const failure = await exec(process.execPath, [
    cli,
    "--home",
    home,
    "check",
    "notes",
    "--json",
  ]).then(
    () => assert.fail("fleet check succeeded for a type error"),
    (error: { stdout?: string }) => error,
  );
  const result = JSON.parse(String(failure.stdout)) as { ok: boolean; errors: string[] };
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /server\/index\.ts\(\d+,\d+\): error TS2322/);
});

async function setupLocal() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v2-cli-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    exec(process.execPath, [cli, "--home", home, ...args], { timeout: 10_000 });
  await run("setup", "--local");
  return { home, run };
}

test("local doctor skips network prerequisites but fails if the daemon is down", async () => {
  const { home, run } = await setupLocal();
  const daemon = await start(home, { httpsPort: 0, dnsPort: 0, adminPort: 0 });
  try {
    const { stdout } = await run("doctor", "--json");
    const [tailscale, daemonCheck, dns] = JSON.parse(stdout) as Array<Record<string, unknown>>;
    assert.deepEqual(daemonCheck, { check: "daemon", ok: true, apps: 0 });
    for (const [check, name] of [
      [tailscale, "tailscale"],
      [dns, "system-dns"],
    ] as const) {
      assert.equal(check.check, name);
      assert.equal(check.skipped, true);
      assert.equal(check.ok, null);
    }
  } finally {
    await daemon.close();
  }

  await assert.rejects(run("doctor", "--json"), (error: unknown) => {
    const err = error as { code?: number; stdout?: string };
    assert.equal(err.code, 1);
    const parsed = JSON.parse(err.stdout || "[]") as Array<{ ok: boolean | null; check: string }>;
    assert.deepEqual(
      parsed.filter((check) => check.ok === false).map((check) => check.check),
      ["daemon"],
    );
    return true;
  });
});

test("local phone off is a successful no-op without a phone route", async () => {
  const { run } = await setupLocal();
  const { stdout } = await run("phone", "off", "--json");
  assert.equal(JSON.parse(stdout), "There is no Fleet phone setup route to remove.");
});

test("CLI UI omits ANSI escapes when color is disabled and renders truecolor wordmark when enabled", async () => {
  const { stdout } = await exec(process.execPath, [cli, "--help"], {
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(stdout.includes("\x1b["), false, "piped/NO_COLOR help must not emit ANSI escapes");
  assert.match(stdout, /personal apps on your own computers/);

  const coloredBanner = renderWordmarkBanner("2.0.0", { color: true });
  assert.equal(coloredBanner.includes("\x1b[38;2;168;115;250m"), true);
  assert.equal(coloredBanner.split("\n").length, 5);

  const plainBanner = renderWordmarkBanner("2.0.0", { color: false });
  assert.equal(plainBanner.includes("\x1b["), false);
  assert.equal(plainBanner.split("\n").length, 5);

  const help = formatHelp("2.0.0", { color: false });
  assert.match(help, /APPS/);
  assert.match(help, /DEVICES & ACCESS/);
  assert.match(help, /fleet call APP queries\|mutations\|jobs OP \[JSON\]/);

  const list = formatAppList(
    [
      {
        id: "1",
        name: "notes",
        directory: "/tmp/notes",
        running: true,
        building: false,
        revision: "a1b2c3d4e5",
        error: null,
      },
    ],
    { color: false },
  );
  assert.match(list, /notes/);
  assert.match(list, /● running/);
  assert.match(list, /https:\/\/notes\.fleet/);

  const inspect = formatInspect(
    {
      id: "1",
      name: "notes",
      directory: "/tmp/notes",
      running: true,
      building: false,
      revision: "a1b2c3d4",
      error: null,
      operations: { queries: ["notes"], mutations: ["addNote"], jobs: ["digest"] },
      jobs: [{ name: "digest", everySeconds: 3600 }],
    },
    { color: false },
  );
  assert.match(inspect, /Queries\s+notes/);
  assert.match(inspect, /digest \(every 1h\)/);

  const doctor = formatDoctor(
    [
      { check: "tailscale", ok: true, dnsName: "mac.ts.net", addresses: ["100.64.0.1"] },
      { check: "daemon", ok: true, apps: 2 },
      { check: "system-dns", ok: true, addresses: [{ address: "100.64.0.1" }] },
    ],
    { color: false },
  );
  assert.match(doctor, /All checks passed\./);

  assert.match(formatInit("notes", "/tmp/notes", { color: false }), /Created notes/);
  assert.match(formatGateCode("ABCD-1234", { color: false }), /ABCD-1234/);
});
