import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "npm/bin", `fleet${process.platform === "win32" ? ".exe" : ""}`);
const targets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
};
const target = targets[`${process.platform}-${process.arch}`];

if (process.argv.includes("--check")) {
  if (!target) throw new Error(`unsupported npm platform: ${process.platform}-${process.arch}`);
  console.log(`npm installer target: ${target}`);
  process.exit(0);
}

await mkdir(dirname(output), { recursive: true });
const staging = join(root, "npm", `.fleet-install-${process.pid}`);
const stagedBinary = join(staging, "fleet");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
if (process.env.FLEET_BINARY) {
  try {
    await copyFile(process.env.FLEET_BINARY, stagedBinary);
    await chmod(stagedBinary, 0o755);
    await rename(stagedBinary, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  process.exit(0);
}
if (!target) {
  await rm(staging, { recursive: true, force: true });
  throw new Error(`Fleet does not publish a binary for ${process.platform}-${process.arch}`);
}

const repository = process.env.FLEET_GITHUB_REPOSITORY || "extoci/fleet";
const version = process.env.npm_package_version;
const base = process.env.FLEET_RELEASE_BASE || `https://github.com/${repository}/releases/download/v${version}`;
const archive = join(staging, `fleet-${target}.tar.gz`);
const temporary = `${archive}.download`;
try {
  await download(`${base}/fleet-${target}.tar.gz`, temporary);
  await rename(temporary, archive);
  const checksum = `${archive}.sha256`;
  await download(`${base}/fleet-${target}.tar.gz.sha256`, checksum);
  const expected = (await readFile(checksum, "utf8")).trim().split(/\s+/)[0];
  const actual = await digest(archive);
  if (actual !== expected) throw new Error("Fleet binary checksum mismatch");
  const unpack = spawnSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  if (unpack.status !== 0 || !existsSync(stagedBinary)) throw new Error("could not unpack the Fleet binary");
  await chmod(stagedBinary, 0o755);
  await rename(stagedBinary, output);
} finally {
  await rm(staging, { recursive: true, force: true });
}

function download(url, destination, redirects = 0) {
  if (redirects > 8) throw new Error("too many download redirects");
  return new Promise((resolve, reject) => {
    const client = new URL(url).protocol === "http:" ? httpGet : httpsGet;
    const request = client(url, { headers: { "User-Agent": "fleet-npm-installer" } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(download(new URL(response.headers.location, url), destination, redirects + 1));
      } else if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`download failed (${response.statusCode}): ${url}`));
      } else {
        resolve(pipeline(response, createWriteStream(destination)));
      }
    });
    request.setTimeout(30_000, () => request.destroy(new Error(`download timed out: ${url}`)));
    request.on("error", reject);
  });
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
