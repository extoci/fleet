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

const unixTest = process.platform === "win32" ? test.skip : test;

unixTest("install.sh verifies checksums and installs a working fleet command", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-installer-test-"));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

  execFileSync("sh", ["-n", path.join(repoRoot, "install.sh")]);

  // Build a realistic release tarball containing source, templates, and preact.
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
  execFileSync("tar", ["-czf", archive, "-C", bundleDir, "."]);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const checksumFile = `${archive}.sha256`;
  fs.writeFileSync(checksumFile, `${digest}  fleet.tar.gz\n`);

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

  execFileSync("sh", [path.join(repoRoot, "install.sh")], { env, stdio: "pipe" });
  const installedFleet = path.join(binDir, "fleet");
  assert.ok(fs.existsSync(installedFleet));

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
