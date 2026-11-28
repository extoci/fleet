import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

test("website public installer copies stay in sync with root installer scripts", () => {
  const rootSh = fs.readFileSync(path.join(repoRoot, "install.sh"), "utf8");
  const rootPs1 = fs.readFileSync(path.join(repoRoot, "install.ps1"), "utf8");
  assert.equal(fs.readFileSync(path.join(repoRoot, "web", "public", "install"), "utf8"), rootSh);
  assert.equal(fs.readFileSync(path.join(repoRoot, "web", "public", "install.sh"), "utf8"), rootSh);
  assert.equal(
    fs.readFileSync(path.join(repoRoot, "web", "public", "install.ps1"), "utf8"),
    rootPs1,
  );
});

function releaseFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-installer-test-"));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bundleDir = path.join(tmp, "bundle");
  fs.mkdirSync(bundleDir, { recursive: true });
  for (const item of ["package.json", "bun.lock", "src", "templates", "LICENSE"]) {
    fs.cpSync(path.join(repoRoot, item), path.join(bundleDir, item), { recursive: true });
  }
  for (const dep of [
    "dns-packet",
    "node-forge",
    "preact",
    "qrcode",
    "dijkstrajs",
    "pngjs",
    "y18n",
  ]) {
    const srcDep = path.join(repoRoot, "node_modules", dep);
    if (fs.existsSync(srcDep)) {
      fs.cpSync(srcDep, path.join(bundleDir, "node_modules", dep), { recursive: true });
    }
  }
  const archive = path.join(tmp, "fleet.tar.gz");
  const checksumFile = `${archive}.sha256`;
  const pack = () => {
    execFileSync("tar", ["-czf", archive, "-C", bundleDir, "."]);
    const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    fs.writeFileSync(checksumFile, `${digest}  fleet.tar.gz\n`);
  };
  return { tmp, bundleDir, archive, checksumFile, pack };
}

const unixTest = process.platform === "win32" ? test.skip : test;

unixTest("install.sh verifies checksums and installs a working fleet command", () => {
  const { tmp, archive, checksumFile, pack } = releaseFixture();
  execFileSync("sh", ["-n", path.join(repoRoot, "install.sh")]);
  pack();

  const fakeHome = path.join(tmp, "home");
  const binDir = path.join(fakeHome, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: fakeHome,
    SHELL: "/bin/bash",
    PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}`,
    FLEET_ARCHIVE: archive,
    FLEET_NO_INSTALL_BUN: "1",
  };

  const installOut = execFileSync("sh", [path.join(repoRoot, "install.sh")], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(installOut, /fleet agent --install/);
  const installedFleet = path.join(binDir, "fleet");
  assert.ok(fs.existsSync(installedFleet));
  assert.equal(
    fs.readFileSync(path.join(fakeHome, ".fleet", "runtime", ".fleet-release"), "utf8").trim(),
    "extoci/fleet",
  );

  const versionOut = execFileSync(installedFleet, ["--version"], {
    env,
    encoding: "utf8",
  }).trim();
  assert.equal(versionOut, `Fleet ${pkg.version}`);

  // Re-running install.sh updates in place cleanly.
  execFileSync("sh", [path.join(repoRoot, "install.sh")], { env, stdio: "pipe" });
  assert.equal(
    execFileSync(installedFleet, ["--version"], { env, encoding: "utf8" }).trim(),
    `Fleet ${pkg.version}`,
  );

  // Tampered checksum must be rejected.
  fs.writeFileSync(checksumFile, `${"0".repeat(64)}  fleet.tar.gz\n`);
  assert.throws(
    () => execFileSync("sh", [path.join(repoRoot, "install.sh")], { env, stdio: "pipe" }),
    /checksum/i,
  );
});

test("fleet update verifies, installs, and restores the runtime on service failure", () => {
  const { tmp, bundleDir, archive, checksumFile, pack } = releaseFixture();
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  const nextVersion = `${major}.${minor}.${patch + 1}`;
  const runtime = path.join(tmp, "fleet runtime");
  const home = path.join(tmp, "fleet state");
  const registry = path.join(home, "apps.json");
  const running = path.join(home, "running.json");
  const restarts = path.join(home, "restarts");
  fs.mkdirSync(home);
  fs.writeFileSync(registry, "[]");
  fs.writeFileSync(path.join(home, "config.json"), "{}");

  // Replace the platform service calls in the installed runtime and release fixture.
  const platform = path.join(bundleDir, "src", "platform.ts");
  fs.renameSync(platform, path.join(bundleDir, "src", "platform-real.ts"));
  fs.writeFileSync(
    platform,
    `
import fs from "node:fs";
import pkg from "../package.json";
export * from "./platform-real.ts";
export const installedService = () => ({ home: ${JSON.stringify(home)}, active: true });
export async function install(home, config, refresh) {
  if (home !== ${JSON.stringify(home)} || !refresh?.active) throw new Error("Expected service restart");
  if (pkg.version === "${nextVersion}" && process.env.FLEET_TEST_SERVICE_FAILURE) {
    throw new Error("Service restart failed");
  }
  fs.appendFileSync(${JSON.stringify(restarts)}, pkg.version + "\\n");
  fs.writeFileSync(${JSON.stringify(running)}, JSON.stringify({ pid: process.ppid }));
}`,
  );
  fs.cpSync(bundleDir, runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, ".fleet-release"), "extoci/fleet\n");
  fs.writeFileSync(
    path.join(bundleDir, "package.json"),
    JSON.stringify({ ...pkg, version: nextVersion }),
  );
  pack();
  const checksum = fs.readFileSync(checksumFile, "utf8");
  fs.writeFileSync(checksumFile, `${"0".repeat(64)}  fleet.tar.gz\n`);
  const preload = path.join(tmp, "github.ts");
  fs.writeFileSync(
    preload,
    `
globalThis.fetch = async (url) => {
  if (url === "https://api.github.com/repos/extoci/fleet/releases/latest") {
    return Response.json({ tag_name: "v${nextVersion}" });
  }
  const origin = "https://github.com/extoci/fleet/releases/download/v${nextVersion}";
  if (process.env.FLEET_TEST_METADATA_ONLY) throw new Error("Unexpected asset download");
  if (url === origin + "/fleet.tar.gz") return new Response(Bun.file(${JSON.stringify(archive)}));
  if (url === origin + "/fleet.tar.gz.sha256") return new Response(Bun.file(${JSON.stringify(checksumFile)}));
  throw new Error("Unexpected download " + url);
};`,
  );
  const cli = path.join(runtime, "src", "cli.ts");
  const update = (env: Record<string, string> = {}) =>
    execFileSync(
      process.execPath,
      ["--preload", preload, cli, "update", "--home", home, "--json"],
      {
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 25_000,
      },
    );
  const version = () =>
    execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();

  assert.throws(() => update(), /checksum did not match/i);
  assert.equal(version(), `Fleet ${pkg.version}`);
  fs.writeFileSync(checksumFile, checksum);
  assert.throws(
    () => update({ FLEET_TEST_SERVICE_FAILURE: "1" }),
    /was restored after the update failed/i,
  );
  assert.equal(version(), `Fleet ${pkg.version}`);
  assert.equal(fs.readFileSync(restarts, "utf8"), `${pkg.version}\n`);
  fs.rmSync(running);

  assert.deepEqual(JSON.parse(update()), {
    updated: true,
    previous: pkg.version,
    version: nextVersion,
    hint: "Run fleet agent --install to refresh any installed agent skill.",
  });
  assert.equal(version(), `Fleet ${nextVersion}`);
  assert.equal(fs.readFileSync(restarts, "utf8"), `${pkg.version}\n${nextVersion}\n`);
  assert.equal(fs.readFileSync(registry, "utf8"), "[]");
  assert.deepEqual(JSON.parse(update({ FLEET_TEST_METADATA_ONLY: "1" })), {
    updated: false,
    previous: nextVersion,
    version: nextVersion,
  });

  // Human-readable output includes the agent skill refresh tip after an update.
  const humanVersion = `${major}.${minor}.${patch + 2}`;
  fs.writeFileSync(
    path.join(bundleDir, "package.json"),
    JSON.stringify({ ...pkg, version: humanVersion }),
  );
  pack();
  fs.writeFileSync(
    preload,
    `
globalThis.fetch = async (url) => {
  if (url === "https://api.github.com/repos/extoci/fleet/releases/latest") {
    return Response.json({ tag_name: "v${humanVersion}" });
  }
  const origin = "https://github.com/extoci/fleet/releases/download/v${humanVersion}";
  if (url === origin + "/fleet.tar.gz") return new Response(Bun.file(${JSON.stringify(archive)}));
  if (url === origin + "/fleet.tar.gz.sha256") return new Response(Bun.file(${JSON.stringify(checksumFile)}));
  throw new Error("Unexpected download " + url);
};`,
  );
  const humanOut = execFileSync(
    process.execPath,
    ["--preload", preload, cli, "update", "--home", home],
    {
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
    },
  );
  assert.match(humanOut, new RegExp(`Updated Fleet from ${nextVersion} to ${humanVersion}\\.`));
  assert.match(humanOut, /Run fleet agent --install to refresh any installed agent skill\./);
  assert.ok(!fs.existsSync(`${runtime}.update`));
}, 30_000);
